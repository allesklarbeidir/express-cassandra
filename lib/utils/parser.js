'use strict';

var Promise = require('bluebird');
var _ = require('lodash');
var util = require('util');

var dseDriver = void 0;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, import/no-unresolved
  dseDriver = require('dse-driver');
} catch (e) {
  dseDriver = null;
}

var cql = Promise.promisifyAll(dseDriver || require('cassandra-driver'));

var buildError = require('../orm/apollo_error.js');
var datatypes = require('../validators/datatypes');
var schemer = require('../validators/schema');

var parser = {};

parser.formatJSONBColumnAware = function (formatString) {

  var placeholders = [];

  var re = /%./g;
  var match = void 0;
  do {
    match = re.exec(formatString);
    if (match) {
      placeholders.push(match);
    }
  } while (match);

  for (var _len = arguments.length, params = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
    params[_key - 1] = arguments[_key];
  }

  (params || []).forEach(function (p, i) {
    if (i < placeholders.length && typeof p === "string" && p.indexOf("->") !== -1) {
      var fp = placeholders[i];
      if (fp.index > 0 && formatString.length > fp.index + 2 && formatString[fp.index - 1] === '"' && formatString[fp.index + 2] === '"') {
        formatString[fp.index - 1] = " ";
        formatString[fp.index + 2] = " ";
      }
    }
  });

  return util.format.apply(util, [formatString].concat(params));
};

parser.callback_or_throw = function f(err, callback) {
  if (typeof callback === 'function') {
    callback(err);
    return;
  }
  throw err;
};

parser.extract_type = function f(val) {
  // decompose composite types
  var decomposed = val ? val.replace(/[\s]/g, '').split(/[<,>]/g) : [''];

  for (var d = 0; d < decomposed.length; d++) {
    if (_.has(datatypes, decomposed[d])) {
      return decomposed[d];
    }
  }

  return val;
};

parser.extract_typeDef = function f(val) {
  // decompose composite types
  var decomposed = val ? val.replace(/[\s]/g, '') : '';
  decomposed = decomposed.substr(decomposed.indexOf('<'), decomposed.length - decomposed.indexOf('<'));

  return decomposed;
};

parser.extract_altered_type = function f(normalizedModelSchema, diff) {
  var fieldName = diff.path[0];
  var type = '';
  if (diff.path.length > 1) {
    if (diff.path[1] === 'type') {
      type = diff.rhs;
      if (normalizedModelSchema.fields[fieldName].typeDef) {
        type += normalizedModelSchema.fields[fieldName].typeDef;
      }
    } else {
      type = normalizedModelSchema.fields[fieldName].type;
      type += diff.rhs;
    }
  } else {
    type = diff.rhs.type;
    if (diff.rhs.typeDef) type += diff.rhs.typeDef;
  }
  return type;
};

parser.get_db_value_expression = function f(schema, fieldName, fieldValue) {
  if (fieldValue == null || fieldValue === cql.types.unset) {
    return { query_segment: '?', parameter: fieldValue };
  }

  if (_.isPlainObject(fieldValue) && fieldValue.$db_function) {
    return fieldValue.$db_function;
  }

  var fieldType = schemer.get_field_type(schema, fieldName);
  var validators = schemer.get_validators(schema, fieldName);

  if (_.isArray(fieldValue) && fieldType !== 'list' && fieldType !== 'set' && fieldType !== 'frozen') {
    var val = fieldValue.map(function (v) {
      var dbVal = parser.get_db_value_expression(schema, fieldName, v);

      if (_.isPlainObject(dbVal) && dbVal.query_segment) return dbVal.parameter;
      return dbVal;
    });

    return { query_segment: '?', parameter: val };
  }

  var validationMessage = schemer.get_validation_message(validators, fieldValue);
  if (typeof validationMessage === 'function') {
    throw buildError('model.validator.invalidvalue', validationMessage(fieldValue, fieldName, fieldType));
  }

  if (fieldType === 'counter') {
    var counterQuerySegment = parser.formatJSONBColumnAware('"%s"', fieldName);
    if (fieldValue >= 0) counterQuerySegment += ' + ?';else counterQuerySegment += ' - ?';
    fieldValue = Math.abs(fieldValue);
    return { query_segment: counterQuerySegment, parameter: fieldValue };
  }

  return { query_segment: '?', parameter: fieldValue };
};

parser.unset_not_allowed = function f(operation, schema, fieldName, callback) {
  if (schemer.is_primary_key_field(schema, fieldName)) {
    parser.callback_or_throw(buildError(`model.${operation}.unsetkey`, fieldName), callback);
    return true;
  }
  if (schemer.is_required_field(schema, fieldName)) {
    parser.callback_or_throw(buildError(`model.${operation}.unsetrequired`, fieldName), callback);
    return true;
  }
  return false;
};

parser.get_inplace_update_expression = function f(schema, fieldName, fieldValue, updateClauses, queryParams) {
  var $add = _.isPlainObject(fieldValue) && fieldValue.$add || false;
  var $append = _.isPlainObject(fieldValue) && fieldValue.$append || false;
  var $prepend = _.isPlainObject(fieldValue) && fieldValue.$prepend || false;
  var $replace = _.isPlainObject(fieldValue) && fieldValue.$replace || false;
  var $remove = _.isPlainObject(fieldValue) && fieldValue.$remove || false;

  fieldValue = $add || $append || $prepend || $replace || $remove || fieldValue;

  var dbVal = parser.get_db_value_expression(schema, fieldName, fieldValue);

  if (!_.isPlainObject(dbVal) || !dbVal.query_segment) {
    updateClauses.push(parser.formatJSONBColumnAware('"%s"=%s', fieldName, dbVal));
    return;
  }

  var fieldType = schemer.get_field_type(schema, fieldName);

  if (['map', 'list', 'set'].includes(fieldType)) {
    if ($add || $append) {
      dbVal.query_segment = parser.formatJSONBColumnAware('"%s" + %s', fieldName, dbVal.query_segment);
    } else if ($prepend) {
      if (fieldType === 'list') {
        dbVal.query_segment = parser.formatJSONBColumnAware('%s + "%s"', dbVal.query_segment, fieldName);
      } else {
        throw buildError('model.update.invalidprependop', util.format('%s datatypes does not support $prepend, use $add instead', fieldType));
      }
    } else if ($remove) {
      dbVal.query_segment = parser.formatJSONBColumnAware('"%s" - %s', fieldName, dbVal.query_segment);
      if (fieldType === 'map') dbVal.parameter = Object.keys(dbVal.parameter);
    }
  }

  if ($replace) {
    if (fieldType === 'map') {
      updateClauses.push(parser.formatJSONBColumnAware('"%s"[?]=%s', fieldName, dbVal.query_segment));
      var replaceKeys = Object.keys(dbVal.parameter);
      var replaceValues = _.values(dbVal.parameter);
      if (replaceKeys.length === 1) {
        queryParams.push(replaceKeys[0]);
        queryParams.push(replaceValues[0]);
      } else {
        throw buildError('model.update.invalidreplaceop', '$replace in map does not support more than one item');
      }
    } else if (fieldType === 'list') {
      updateClauses.push(parser.formatJSONBColumnAware('"%s"[?]=%s', fieldName, dbVal.query_segment));
      if (dbVal.parameter.length === 2) {
        queryParams.push(dbVal.parameter[0]);
        queryParams.push(dbVal.parameter[1]);
      } else {
        throw buildError('model.update.invalidreplaceop', '$replace in list should have exactly 2 items, first one as the index and the second one as the value');
      }
    } else {
      throw buildError('model.update.invalidreplaceop', util.format('%s datatypes does not support $replace', fieldType));
    }
  } else {
    updateClauses.push(parser.formatJSONBColumnAware('"%s"=%s', fieldName, dbVal.query_segment));
    queryParams.push(dbVal.parameter);
  }
};

parser.get_update_value_expression = function f(instance, schema, updateValues, callback) {
  var updateClauses = [];
  var queryParams = [];

  if (schema.options && schema.options.timestamps) {
    if (!updateValues[schema.options.timestamps.updatedAt]) {
      updateValues[schema.options.timestamps.updatedAt] = { $db_function: 'toTimestamp(now())' };
    }
  }

  if (schema.options && schema.options.versions) {
    if (!updateValues[schema.options.versions.key]) {
      updateValues[schema.options.versions.key] = { $db_function: 'now()' };
    }
  }

  var errorHappened = Object.keys(updateValues).some(function (fieldName) {
    if (schema.fields[fieldName] === undefined || schema.fields[fieldName].virtual) return false;

    var fieldType = schemer.get_field_type(schema, fieldName);
    var fieldValue = updateValues[fieldName];

    if (fieldValue === undefined) {
      fieldValue = instance._get_default_value(fieldName);
      if (fieldValue === undefined) {
        return parser.unset_not_allowed('update', schema, fieldName, callback);
      } else if (!schema.fields[fieldName].rule || !schema.fields[fieldName].rule.ignore_default) {
        // did set a default value, ignore default is not set
        if (instance.validate(fieldName, fieldValue) !== true) {
          parser.callback_or_throw(buildError('model.update.invaliddefaultvalue', fieldValue, fieldName, fieldType), callback);
          return true;
        }
      }
    }

    if (fieldValue === null || fieldValue === cql.types.unset) {
      if (parser.unset_not_allowed('update', schema, fieldName, callback)) {
        return true;
      }
    }

    try {
      parser.get_inplace_update_expression(schema, fieldName, fieldValue, updateClauses, queryParams);
    } catch (e) {
      parser.callback_or_throw(e, callback);
      return true;
    }
    return false;
  });

  return { updateClauses, queryParams, errorHappened };
};

parser.get_save_value_expression = function fn(instance, schema, callback) {
  var identifiers = [];
  var values = [];
  var queryParams = [];

  if (schema.options && schema.options.timestamps) {
    if (instance[schema.options.timestamps.updatedAt]) {
      instance[schema.options.timestamps.updatedAt] = { $db_function: 'toTimestamp(now())' };
    }
  }

  if (schema.options && schema.options.versions) {
    if (instance[schema.options.versions.key]) {
      instance[schema.options.versions.key] = { $db_function: 'now()' };
    }
  }

  var errorHappened = Object.keys(schema.fields).some(function (fieldName) {
    if (schema.fields[fieldName].virtual) return false;

    // check field value
    var fieldType = schemer.get_field_type(schema, fieldName);
    var fieldValue = instance[fieldName];

    if (fieldValue === undefined) {
      fieldValue = instance._get_default_value(fieldName);
      if (fieldValue === undefined) {
        return parser.unset_not_allowed('save', schema, fieldName, callback);
      } else if (!schema.fields[fieldName].rule || !schema.fields[fieldName].rule.ignore_default) {
        // did set a default value, ignore default is not set
        if (instance.validate(fieldName, fieldValue) !== true) {
          parser.callback_or_throw(buildError('model.save.invaliddefaultvalue', fieldValue, fieldName, fieldType), callback);
          return true;
        }
      }
    }

    if (fieldValue === null || fieldValue === cql.types.unset) {
      if (parser.unset_not_allowed('save', schema, fieldName, callback)) {
        return true;
      }
    }

    identifiers.push(parser.formatJSONBColumnAware('"%s"', fieldName));

    try {
      var dbVal = parser.get_db_value_expression(schema, fieldName, fieldValue);
      if (_.isPlainObject(dbVal) && dbVal.query_segment) {
        values.push(dbVal.query_segment);
        queryParams.push(dbVal.parameter);
      } else {
        values.push(dbVal);
      }
    } catch (e) {
      parser.callback_or_throw(e, callback);
      return true;
    }
    return false;
  });

  return {
    identifiers,
    values,
    queryParams,
    errorHappened
  };
};

parser.extract_query_relations = function f(fieldName, relationKey, relationValue, schema, validOperators) {
  var queryRelations = [];
  var queryParams = [];

  if (!_.has(validOperators, relationKey.toLowerCase())) {
    throw buildError('model.find.invalidop', relationKey);
  }

  relationKey = relationKey.toLowerCase();
  if (relationKey === '$in' && !_.isArray(relationValue)) {
    throw buildError('model.find.invalidinop');
  }
  if (relationKey === '$token' && !(relationValue instanceof Object)) {
    throw buildError('model.find.invalidtoken');
  }

  var operator = validOperators[relationKey];
  var whereTemplate = '"%s" %s %s';

  var buildQueryRelations = function buildQueryRelations(fieldNameLocal, relationValueLocal) {
    var dbVal = parser.get_db_value_expression(schema, fieldNameLocal, relationValueLocal);
    if (_.isPlainObject(dbVal) && dbVal.query_segment) {
      queryRelations.push(parser.formatJSONBColumnAware(whereTemplate, fieldNameLocal, operator, dbVal.query_segment));
      queryParams.push(dbVal.parameter);
    } else {
      queryRelations.push(parser.formatJSONBColumnAware(whereTemplate, fieldNameLocal, operator, dbVal));
    }
  };

  var buildTokenQueryRelations = function buildTokenQueryRelations(tokenRelationKey, tokenRelationValue) {
    tokenRelationKey = tokenRelationKey.toLowerCase();
    if (_.has(validOperators, tokenRelationKey) && tokenRelationKey !== '$token' && tokenRelationKey !== '$in') {
      operator = validOperators[tokenRelationKey];
    } else {
      throw buildError('model.find.invalidtokenop', tokenRelationKey);
    }

    if (_.isArray(tokenRelationValue)) {
      var tokenKeys = fieldName.split(',');
      for (var tokenIndex = 0; tokenIndex < tokenRelationValue.length; tokenIndex++) {
        tokenKeys[tokenIndex] = tokenKeys[tokenIndex].trim();
        var dbVal = parser.get_db_value_expression(schema, tokenKeys[tokenIndex], tokenRelationValue[tokenIndex]);
        if (_.isPlainObject(dbVal) && dbVal.query_segment) {
          tokenRelationValue[tokenIndex] = dbVal.query_segment;
          queryParams.push(dbVal.parameter);
        } else {
          tokenRelationValue[tokenIndex] = dbVal;
        }
      }
      queryRelations.push(util.format(whereTemplate, tokenKeys.join('","'), operator, tokenRelationValue.toString()));
    } else {
      buildQueryRelations(fieldName, tokenRelationValue);
    }
  };

  if (relationKey === '$token') {
    whereTemplate = 'token("%s") %s token(%s)';

    var tokenRelationKeys = Object.keys(relationValue);
    for (var tokenRK = 0; tokenRK < tokenRelationKeys.length; tokenRK++) {
      var tokenRelationKey = tokenRelationKeys[tokenRK];
      var tokenRelationValue = relationValue[tokenRelationKey];
      buildTokenQueryRelations(tokenRelationKey, tokenRelationValue);
    }
  } else if (relationKey === '$contains') {
    var fieldType1 = schemer.get_field_type(schema, fieldName);
    if (['map', 'list', 'set', 'frozen'].includes(fieldType1)) {
      if (fieldType1 === 'map' && _.isPlainObject(relationValue)) {
        Object.keys(relationValue).forEach(function (key) {
          queryRelations.push(parser.formatJSONBColumnAware('"%s"[%s] %s %s', fieldName, '?', '=', '?'));
          queryParams.push(key);
          queryParams.push(relationValue[key]);
        });
      } else {
        queryRelations.push(parser.formatJSONBColumnAware(whereTemplate, fieldName, operator, '?'));
        queryParams.push(relationValue);
      }
    } else {
      throw buildError('model.find.invalidcontainsop');
    }
  } else if (relationKey === '$contains_key') {
    var fieldType2 = schemer.get_field_type(schema, fieldName);
    if (fieldType2 !== 'map') {
      throw buildError('model.find.invalidcontainskeyop');
    }
    queryRelations.push(util.format(whereTemplate, fieldName, operator, '?'));
    queryParams.push(relationValue);
  } else {
    buildQueryRelations(fieldName, relationValue);
  }
  return { queryRelations, queryParams };
};

parser._parse_query_object = function f(schema, queryObject) {
  var queryRelations = [];
  var queryParams = [];

  Object.keys(queryObject).forEach(function (fieldName) {
    if (fieldName.startsWith('$')) {
      // search queries based on lucene index or solr
      // escape all single quotes for queries in cassandra
      if (fieldName === '$expr') {
        if (typeof queryObject[fieldName].index === 'string' && typeof queryObject[fieldName].query === 'string') {
          queryRelations.push(util.format("expr(%s,'%s')", queryObject[fieldName].index, queryObject[fieldName].query.replace(/'/g, "''")));
        } else {
          throw buildError('model.find.invalidexpr');
        }
      } else if (fieldName === '$solr_query') {
        if (typeof queryObject[fieldName] === 'string') {
          queryRelations.push(util.format("solr_query='%s'", queryObject[fieldName].replace(/'/g, "''")));
        } else {
          throw buildError('model.find.invalidsolrquery');
        }
      }
      return;
    }

    var whereObject = queryObject[fieldName];
    // Array of operators
    if (!_.isArray(whereObject)) whereObject = [whereObject];

    for (var fk = 0; fk < whereObject.length; fk++) {
      var fieldRelation = whereObject[fk];

      var cqlOperators = {
        $eq: '=',
        $ne: '!=',
        $isnt: 'IS NOT',
        $gt: '>',
        $lt: '<',
        $gte: '>=',
        $lte: '<=',
        $in: 'IN',
        $like: 'LIKE',
        $token: 'token',
        $contains: 'CONTAINS',
        $contains_key: 'CONTAINS KEY'
      };

      if (_.isPlainObject(fieldRelation)) {
        var validKeys = Object.keys(cqlOperators);
        var fieldRelationKeys = Object.keys(fieldRelation);
        for (var i = 0; i < fieldRelationKeys.length; i++) {
          if (!validKeys.includes(fieldRelationKeys[i])) {
            // field relation key invalid, apply default $eq operator
            fieldRelation = { $eq: fieldRelation };
            break;
          }
        }
      } else {
        fieldRelation = { $eq: fieldRelation };
      }

      var relationKeys = Object.keys(fieldRelation);
      for (var rk = 0; rk < relationKeys.length; rk++) {
        var relationKey = relationKeys[rk];
        var relationValue = fieldRelation[relationKey];
        var extractedRelations = parser.extract_query_relations(fieldName, relationKey, relationValue, schema, cqlOperators);
        queryRelations = queryRelations.concat(extractedRelations.queryRelations);
        queryParams = queryParams.concat(extractedRelations.queryParams);
      }
    }
  });

  return { queryRelations, queryParams };
};

parser.get_filter_clause = function f(schema, queryObject, clause) {
  var parsedObject = parser._parse_query_object(schema, queryObject);
  var filterClause = {};
  if (parsedObject.queryRelations.length > 0) {
    filterClause.query = util.format('%s %s', clause, parsedObject.queryRelations.join(' AND '));
  } else {
    filterClause.query = '';
  }
  filterClause.params = parsedObject.queryParams;
  return filterClause;
};

parser.get_filter_clause_ddl = function f(schema, queryObject, clause) {
  var filterClause = parser.get_filter_clause(schema, queryObject, clause);
  var filterQuery = filterClause.query;
  filterClause.params.forEach(function (param) {
    var queryParam = void 0;
    if (typeof param === 'string') {
      queryParam = util.format("'%s'", param);
    } else if (param instanceof Date) {
      queryParam = util.format("'%s'", param.toISOString());
    } else if (param instanceof cql.types.Long || param instanceof cql.types.Integer || param instanceof cql.types.BigDecimal || param instanceof cql.types.TimeUuid || param instanceof cql.types.Uuid) {
      queryParam = param.toString();
    } else if (param instanceof cql.types.LocalDate || param instanceof cql.types.LocalTime || param instanceof cql.types.InetAddress) {
      queryParam = util.format("'%s'", param.toString());
    } else {
      queryParam = param;
    }
    // TODO: unhandled if queryParam is a string containing ? character
    // though this is unlikely to have in materialized view filters, but...
    filterQuery = filterQuery.replace('?', queryParam);
  });
  return filterQuery;
};

parser.get_where_clause = function f(schema, queryObject) {
  return parser.get_filter_clause(schema, queryObject, 'WHERE');
};

parser.get_if_clause = function f(schema, queryObject) {
  return parser.get_filter_clause(schema, queryObject, 'IF');
};

parser.get_primary_key_clauses = function f(schema) {
  var partitionKey = schema.key[0];
  var clusteringKey = schema.key.slice(1, schema.key.length);
  var clusteringOrder = [];

  for (var field = 0; field < clusteringKey.length; field++) {
    if (schema.clustering_order && schema.clustering_order[clusteringKey[field]] && schema.clustering_order[clusteringKey[field]].toLowerCase() === 'desc') {
      clusteringOrder.push(parser.formatJSONBColumnAware('"%s" DESC', clusteringKey[field]));
    } else {
      clusteringOrder.push(parser.formatJSONBColumnAware('"%s" ASC', clusteringKey[field]));
    }
  }

  var clusteringOrderClause = '';
  if (clusteringOrder.length > 0) {
    clusteringOrderClause = util.format(' WITH CLUSTERING ORDER BY (%s)', clusteringOrder.toString());
  }

  var partitionKeyClause = '';
  if (_.isArray(partitionKey)) {
    partitionKeyClause = partitionKey.map(function (v) {
      return parser.formatJSONBColumnAware('"%s"', v);
    }).join(',');
  } else {
    partitionKeyClause = parser.formatJSONBColumnAware('"%s"', partitionKey);
  }

  var clusteringKeyClause = '';
  if (clusteringKey.length) {
    clusteringKey = clusteringKey.map(function (v) {
      return parser.formatJSONBColumnAware('"%s"', v);
    }).join(',');
    clusteringKeyClause = util.format(',%s', clusteringKey);
  }

  return { partitionKeyClause, clusteringKeyClause, clusteringOrderClause };
};

parser.get_mview_where_clause = function f(schema, viewSchema) {
  var clauses = parser.get_primary_key_clauses(viewSchema);
  var whereClause = clauses.partitionKeyClause.split(',').join(' IS NOT NULL AND ');
  if (clauses.clusteringKeyClause) whereClause += clauses.clusteringKeyClause.split(',').join(' IS NOT NULL AND ');
  whereClause += ' IS NOT NULL';

  var filters = _.cloneDeep(viewSchema.filters);

  if (_.isPlainObject(filters)) {
    // delete primary key fields defined as isn't null in filters
    Object.keys(filters).forEach(function (filterKey) {
      if (filters[filterKey].$isnt === null && (viewSchema.key.includes(filterKey) || viewSchema.key[0].includes(filterKey))) {
        delete filters[filterKey].$isnt;
      }
    });

    var filterClause = parser.get_filter_clause_ddl(schema, filters, 'AND');
    whereClause += util.format(' %s', filterClause).replace(/IS NOT null/g, 'IS NOT NULL');
  }

  // remove unnecessarily quoted field names in generated where clause
  // so that it matches the where_clause from database schema
  var quotedFieldNames = whereClause.match(/"(.*?)"/g);
  quotedFieldNames.forEach(function (fieldName) {
    var unquotedFieldName = fieldName.replace(/"/g, '');
    var reservedKeywords = ['ADD', 'AGGREGATE', 'ALLOW', 'ALTER', 'AND', 'ANY', 'APPLY', 'ASC', 'AUTHORIZE', 'BATCH', 'BEGIN', 'BY', 'COLUMNFAMILY', 'CREATE', 'DELETE', 'DESC', 'DROP', 'EACH_QUORUM', 'ENTRIES', 'FROM', 'FULL', 'GRANT', 'IF', 'IN', 'INDEX', 'INET', 'INFINITY', 'INSERT', 'INTO', 'KEYSPACE', 'KEYSPACES', 'LIMIT', 'LOCAL_ONE', 'LOCAL_QUORUM', 'MATERIALIZED', 'MODIFY', 'NAN', 'NORECURSIVE', 'NOT', 'OF', 'ON', 'ONE', 'ORDER', 'PARTITION', 'PASSWORD', 'PER', 'PRIMARY', 'QUORUM', 'RENAME', 'REVOKE', 'SCHEMA', 'SELECT', 'SET', 'TABLE', 'TIME', 'THREE', 'TO', 'TOKEN', 'TRUNCATE', 'TWO', 'UNLOGGED', 'UPDATE', 'USE', 'USING', 'VIEW', 'WHERE', 'WITH'];
    if (unquotedFieldName === unquotedFieldName.toLowerCase() && !reservedKeywords.includes(unquotedFieldName.toUpperCase())) {
      whereClause = whereClause.replace(fieldName, unquotedFieldName);
    }
  });
  return whereClause;
};

parser.get_orderby_clause = function f(queryObject) {
  var orderKeys = [];
  Object.keys(queryObject).forEach(function (k) {
    var queryItem = queryObject[k];
    if (k.toLowerCase() === '$orderby') {
      if (!(queryItem instanceof Object)) {
        throw buildError('model.find.invalidorder');
      }
      var orderItemKeys = Object.keys(queryItem);

      for (var i = 0; i < orderItemKeys.length; i++) {
        var cqlOrderDirection = { $asc: 'ASC', $desc: 'DESC' };
        if (orderItemKeys[i].toLowerCase() in cqlOrderDirection) {
          var orderFields = queryItem[orderItemKeys[i]];

          if (!_.isArray(orderFields)) {
            orderFields = [orderFields];
          }

          for (var j = 0; j < orderFields.length; j++) {
            orderKeys.push(parser.formatJSONBColumnAware('"%s" %s', orderFields[j], cqlOrderDirection[orderItemKeys[i]]));
          }
        } else {
          throw buildError('model.find.invalidordertype', orderItemKeys[i]);
        }
      }
    }
  });
  return orderKeys.length ? util.format('ORDER BY %s', orderKeys.join(', ')) : ' ';
};

parser.get_groupby_clause = function f(queryObject) {
  var groupbyKeys = [];

  Object.keys(queryObject).forEach(function (k) {
    var queryItem = queryObject[k];

    if (k.toLowerCase() === '$groupby') {
      if (!(queryItem instanceof Array)) {
        throw buildError('model.find.invalidgroup');
      }

      groupbyKeys = groupbyKeys.concat(queryItem);
    }
  });

  groupbyKeys = groupbyKeys.map(function (key) {
    return `"${key}"`;
  });

  return groupbyKeys.length ? util.format('GROUP BY %s', groupbyKeys.join(', ')) : ' ';
};

parser.get_limit_clause = function f(queryObject) {
  var limit = null;
  Object.keys(queryObject).forEach(function (k) {
    var queryItem = queryObject[k];
    if (k.toLowerCase() === '$limit') {
      if (typeof queryItem !== 'number') throw buildError('model.find.limittype');
      limit = queryItem;
    }
  });
  return limit ? util.format('LIMIT %s', limit) : ' ';
};

parser.get_select_clause = function f(options) {
  var selectClause = '*';
  if (options.select && _.isArray(options.select) && options.select.length > 0) {
    var selectArray = [];
    for (var i = 0; i < options.select.length; i++) {
      // separate the aggregate function and the column name if select is an aggregate function
      var selection = options.select[i].split(/[(, )]/g).filter(function (e) {
        return e;
      });
      if (selection.length === 1) {
        if (selection[0] === '*') selectArray.push('*');else selectArray.push(parser.formatJSONBColumnAware('"%s"', selection[0]));
      } else if (selection.length === 2) {
        selectArray.push(parser.formatJSONBColumnAware('%s("%s")', selection[0], selection[1]));
      } else if (selection.length >= 3 && selection[selection.length - 2].toLowerCase() === 'as') {
        var selectionEndChunk = selection.splice(selection.length - 2);
        var selectionChunk = '';
        if (selection.length === 1) {
          selectionChunk = parser.formatJSONBColumnAware('"%s"', selection[0]);
        } else if (selection.length === 2) {
          selectionChunk = parser.formatJSONBColumnAware('%s("%s")', selection[0], selection[1]);
        } else {
          selectionChunk = util.format('%s(%s)', selection[0], `"${selection.splice(1).join('","')}"`);
        }
        selectArray.push(parser.formatJSONBColumnAware('%s AS "%s"', selectionChunk, selectionEndChunk[1]));
      } else if (selection.length >= 3) {
        selectArray.push(util.format('%s(%s)', selection[0], `"${selection.splice(1).join('","')}"`));
      }
    }
    selectClause = selectArray.join(',');
  }
  return selectClause;
};

module.exports = parser;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9wYXJzZXIuanMiXSwibmFtZXMiOlsiUHJvbWlzZSIsInJlcXVpcmUiLCJfIiwidXRpbCIsImRzZURyaXZlciIsImUiLCJjcWwiLCJwcm9taXNpZnlBbGwiLCJidWlsZEVycm9yIiwiZGF0YXR5cGVzIiwic2NoZW1lciIsInBhcnNlciIsImZvcm1hdEpTT05CQ29sdW1uQXdhcmUiLCJmb3JtYXRTdHJpbmciLCJwbGFjZWhvbGRlcnMiLCJyZSIsIm1hdGNoIiwiZXhlYyIsInB1c2giLCJwYXJhbXMiLCJmb3JFYWNoIiwicCIsImkiLCJsZW5ndGgiLCJpbmRleE9mIiwiZnAiLCJpbmRleCIsImZvcm1hdCIsImNhbGxiYWNrX29yX3Rocm93IiwiZiIsImVyciIsImNhbGxiYWNrIiwiZXh0cmFjdF90eXBlIiwidmFsIiwiZGVjb21wb3NlZCIsInJlcGxhY2UiLCJzcGxpdCIsImQiLCJoYXMiLCJleHRyYWN0X3R5cGVEZWYiLCJzdWJzdHIiLCJleHRyYWN0X2FsdGVyZWRfdHlwZSIsIm5vcm1hbGl6ZWRNb2RlbFNjaGVtYSIsImRpZmYiLCJmaWVsZE5hbWUiLCJwYXRoIiwidHlwZSIsInJocyIsImZpZWxkcyIsInR5cGVEZWYiLCJnZXRfZGJfdmFsdWVfZXhwcmVzc2lvbiIsInNjaGVtYSIsImZpZWxkVmFsdWUiLCJ0eXBlcyIsInVuc2V0IiwicXVlcnlfc2VnbWVudCIsInBhcmFtZXRlciIsImlzUGxhaW5PYmplY3QiLCIkZGJfZnVuY3Rpb24iLCJmaWVsZFR5cGUiLCJnZXRfZmllbGRfdHlwZSIsInZhbGlkYXRvcnMiLCJnZXRfdmFsaWRhdG9ycyIsImlzQXJyYXkiLCJtYXAiLCJ2IiwiZGJWYWwiLCJ2YWxpZGF0aW9uTWVzc2FnZSIsImdldF92YWxpZGF0aW9uX21lc3NhZ2UiLCJjb3VudGVyUXVlcnlTZWdtZW50IiwiTWF0aCIsImFicyIsInVuc2V0X25vdF9hbGxvd2VkIiwib3BlcmF0aW9uIiwiaXNfcHJpbWFyeV9rZXlfZmllbGQiLCJpc19yZXF1aXJlZF9maWVsZCIsImdldF9pbnBsYWNlX3VwZGF0ZV9leHByZXNzaW9uIiwidXBkYXRlQ2xhdXNlcyIsInF1ZXJ5UGFyYW1zIiwiJGFkZCIsIiRhcHBlbmQiLCIkcHJlcGVuZCIsIiRyZXBsYWNlIiwiJHJlbW92ZSIsImluY2x1ZGVzIiwiT2JqZWN0Iiwia2V5cyIsInJlcGxhY2VLZXlzIiwicmVwbGFjZVZhbHVlcyIsInZhbHVlcyIsImdldF91cGRhdGVfdmFsdWVfZXhwcmVzc2lvbiIsImluc3RhbmNlIiwidXBkYXRlVmFsdWVzIiwib3B0aW9ucyIsInRpbWVzdGFtcHMiLCJ1cGRhdGVkQXQiLCJ2ZXJzaW9ucyIsImtleSIsImVycm9ySGFwcGVuZWQiLCJzb21lIiwidW5kZWZpbmVkIiwidmlydHVhbCIsIl9nZXRfZGVmYXVsdF92YWx1ZSIsInJ1bGUiLCJpZ25vcmVfZGVmYXVsdCIsInZhbGlkYXRlIiwiZ2V0X3NhdmVfdmFsdWVfZXhwcmVzc2lvbiIsImZuIiwiaWRlbnRpZmllcnMiLCJleHRyYWN0X3F1ZXJ5X3JlbGF0aW9ucyIsInJlbGF0aW9uS2V5IiwicmVsYXRpb25WYWx1ZSIsInZhbGlkT3BlcmF0b3JzIiwicXVlcnlSZWxhdGlvbnMiLCJ0b0xvd2VyQ2FzZSIsIm9wZXJhdG9yIiwid2hlcmVUZW1wbGF0ZSIsImJ1aWxkUXVlcnlSZWxhdGlvbnMiLCJmaWVsZE5hbWVMb2NhbCIsInJlbGF0aW9uVmFsdWVMb2NhbCIsImJ1aWxkVG9rZW5RdWVyeVJlbGF0aW9ucyIsInRva2VuUmVsYXRpb25LZXkiLCJ0b2tlblJlbGF0aW9uVmFsdWUiLCJ0b2tlbktleXMiLCJ0b2tlbkluZGV4IiwidHJpbSIsImpvaW4iLCJ0b1N0cmluZyIsInRva2VuUmVsYXRpb25LZXlzIiwidG9rZW5SSyIsImZpZWxkVHlwZTEiLCJmaWVsZFR5cGUyIiwiX3BhcnNlX3F1ZXJ5X29iamVjdCIsInF1ZXJ5T2JqZWN0Iiwic3RhcnRzV2l0aCIsInF1ZXJ5Iiwid2hlcmVPYmplY3QiLCJmayIsImZpZWxkUmVsYXRpb24iLCJjcWxPcGVyYXRvcnMiLCIkZXEiLCIkbmUiLCIkaXNudCIsIiRndCIsIiRsdCIsIiRndGUiLCIkbHRlIiwiJGluIiwiJGxpa2UiLCIkdG9rZW4iLCIkY29udGFpbnMiLCIkY29udGFpbnNfa2V5IiwidmFsaWRLZXlzIiwiZmllbGRSZWxhdGlvbktleXMiLCJyZWxhdGlvbktleXMiLCJyayIsImV4dHJhY3RlZFJlbGF0aW9ucyIsImNvbmNhdCIsImdldF9maWx0ZXJfY2xhdXNlIiwiY2xhdXNlIiwicGFyc2VkT2JqZWN0IiwiZmlsdGVyQ2xhdXNlIiwiZ2V0X2ZpbHRlcl9jbGF1c2VfZGRsIiwiZmlsdGVyUXVlcnkiLCJwYXJhbSIsInF1ZXJ5UGFyYW0iLCJEYXRlIiwidG9JU09TdHJpbmciLCJMb25nIiwiSW50ZWdlciIsIkJpZ0RlY2ltYWwiLCJUaW1lVXVpZCIsIlV1aWQiLCJMb2NhbERhdGUiLCJMb2NhbFRpbWUiLCJJbmV0QWRkcmVzcyIsImdldF93aGVyZV9jbGF1c2UiLCJnZXRfaWZfY2xhdXNlIiwiZ2V0X3ByaW1hcnlfa2V5X2NsYXVzZXMiLCJwYXJ0aXRpb25LZXkiLCJjbHVzdGVyaW5nS2V5Iiwic2xpY2UiLCJjbHVzdGVyaW5nT3JkZXIiLCJmaWVsZCIsImNsdXN0ZXJpbmdfb3JkZXIiLCJjbHVzdGVyaW5nT3JkZXJDbGF1c2UiLCJwYXJ0aXRpb25LZXlDbGF1c2UiLCJjbHVzdGVyaW5nS2V5Q2xhdXNlIiwiZ2V0X212aWV3X3doZXJlX2NsYXVzZSIsInZpZXdTY2hlbWEiLCJjbGF1c2VzIiwid2hlcmVDbGF1c2UiLCJmaWx0ZXJzIiwiY2xvbmVEZWVwIiwiZmlsdGVyS2V5IiwicXVvdGVkRmllbGROYW1lcyIsInVucXVvdGVkRmllbGROYW1lIiwicmVzZXJ2ZWRLZXl3b3JkcyIsInRvVXBwZXJDYXNlIiwiZ2V0X29yZGVyYnlfY2xhdXNlIiwib3JkZXJLZXlzIiwiayIsInF1ZXJ5SXRlbSIsIm9yZGVySXRlbUtleXMiLCJjcWxPcmRlckRpcmVjdGlvbiIsIiRhc2MiLCIkZGVzYyIsIm9yZGVyRmllbGRzIiwiaiIsImdldF9ncm91cGJ5X2NsYXVzZSIsImdyb3VwYnlLZXlzIiwiQXJyYXkiLCJnZXRfbGltaXRfY2xhdXNlIiwibGltaXQiLCJnZXRfc2VsZWN0X2NsYXVzZSIsInNlbGVjdENsYXVzZSIsInNlbGVjdCIsInNlbGVjdEFycmF5Iiwic2VsZWN0aW9uIiwiZmlsdGVyIiwic2VsZWN0aW9uRW5kQ2h1bmsiLCJzcGxpY2UiLCJzZWxlY3Rpb25DaHVuayIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7O0FBQUEsSUFBTUEsVUFBVUMsUUFBUSxVQUFSLENBQWhCO0FBQ0EsSUFBTUMsSUFBSUQsUUFBUSxRQUFSLENBQVY7QUFDQSxJQUFNRSxPQUFPRixRQUFRLE1BQVIsQ0FBYjs7QUFFQSxJQUFJRyxrQkFBSjtBQUNBLElBQUk7QUFDRjtBQUNBQSxjQUFZSCxRQUFRLFlBQVIsQ0FBWjtBQUNELENBSEQsQ0FHRSxPQUFPSSxDQUFQLEVBQVU7QUFDVkQsY0FBWSxJQUFaO0FBQ0Q7O0FBRUQsSUFBTUUsTUFBTU4sUUFBUU8sWUFBUixDQUFxQkgsYUFBYUgsUUFBUSxrQkFBUixDQUFsQyxDQUFaOztBQUVBLElBQU1PLGFBQWFQLFFBQVEsd0JBQVIsQ0FBbkI7QUFDQSxJQUFNUSxZQUFZUixRQUFRLHlCQUFSLENBQWxCO0FBQ0EsSUFBTVMsVUFBVVQsUUFBUSxzQkFBUixDQUFoQjs7QUFFQSxJQUFNVSxTQUFTLEVBQWY7O0FBRUFBLE9BQU9DLHNCQUFQLEdBQWdDLFVBQVNDLFlBQVQsRUFBaUM7O0FBRS9ELE1BQU1DLGVBQWUsRUFBckI7O0FBRUEsTUFBTUMsS0FBSyxLQUFYO0FBQ0EsTUFBSUMsY0FBSjtBQUNBLEtBQUc7QUFDQ0EsWUFBUUQsR0FBR0UsSUFBSCxDQUFRSixZQUFSLENBQVI7QUFDQSxRQUFJRyxLQUFKLEVBQVc7QUFDUEYsbUJBQWFJLElBQWIsQ0FBa0JGLEtBQWxCO0FBQ0g7QUFDSixHQUxELFFBS1NBLEtBTFQ7O0FBTitELG9DQUFQ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VSxDQUFWLENBQXRCLEVBQXFDLElBQUdBLFVBQVVHLE1BQVYsQ0FBaUIsQ0FBakIsRUFBb0IvRixJQUFwQixDQUF5QixLQUF6QixDQUFnQyxHQUF4RSxDQUFqQjtBQUNEO0FBQ0Y7QUFDRHlGLG1CQUFlRSxZQUFZM0YsSUFBWixDQUFpQixHQUFqQixDQUFmO0FBQ0Q7QUFDRCxTQUFPeUYsWUFBUDtBQUNELENBOUJEOztBQWdDQVEsT0FBT0MsT0FBUCxHQUFpQnJOLE1BQWpCIiwiZmlsZSI6InBhcnNlci5qcyIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IFByb21pc2UgPSByZXF1aXJlKCdibHVlYmlyZCcpO1xuY29uc3QgXyA9IHJlcXVpcmUoJ2xvZGFzaCcpO1xuY29uc3QgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcblxubGV0IGRzZURyaXZlcjtcbnRyeSB7XG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBpbXBvcnQvbm8tZXh0cmFuZW91cy1kZXBlbmRlbmNpZXMsIGltcG9ydC9uby11bnJlc29sdmVkXG4gIGRzZURyaXZlciA9IHJlcXVpcmUoJ2RzZS1kcml2ZXInKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZHNlRHJpdmVyID0gbnVsbDtcbn1cblxuY29uc3QgY3FsID0gUHJvbWlzZS5wcm9taXNpZnlBbGwoZHNlRHJpdmVyIHx8IHJlcXVpcmUoJ2Nhc3NhbmRyYS1kcml2ZXInKSk7XG5cbmNvbnN0IGJ1aWxkRXJyb3IgPSByZXF1aXJlKCcuLi9vcm0vYXBvbGxvX2Vycm9yLmpzJyk7XG5jb25zdCBkYXRhdHlwZXMgPSByZXF1aXJlKCcuLi92YWxpZGF0b3JzL2RhdGF0eXBlcycpO1xuY29uc3Qgc2NoZW1lciA9IHJlcXVpcmUoJy4uL3ZhbGlkYXRvcnMvc2NoZW1hJyk7XG5cbmNvbnN0IHBhcnNlciA9IHt9O1xuXG5wYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSA9IGZ1bmN0aW9uKGZvcm1hdFN0cmluZywgLi4ucGFyYW1zKXtcblxuICBjb25zdCBwbGFjZWhvbGRlcnMgPSBbXTtcblxuICBjb25zdCByZSA9IC8lLi9nO1xuICBsZXQgbWF0Y2g7XG4gIGRvIHtcbiAgICAgIG1hdGNoID0gcmUuZXhlYyhmb3JtYXRTdHJpbmcpO1xuICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgICAgcGxhY2Vob2xkZXJzLnB1c2gobWF0Y2gpXG4gICAgICB9XG4gIH0gd2hpbGUgKG1hdGNoKTtcblxuICAocGFyYW1zIHx8IFtdKS5mb3JFYWNoKChwLGkpID0+IHtcbiAgICBpZihpIDwgcGxhY2Vob2xkZXJzLmxlbmd0aCAmJiB0eXBlb2YocCkgPT09IFwic3RyaW5nXCIgJiYgcC5pbmRleE9mKFwiLT5cIikgIT09IC0xKXtcbiAgICAgIGNvbnN0IGZwID0gcGxhY2Vob2xkZXJzW2ldO1xuICAgICAgaWYoXG4gICAgICAgIGZwLmluZGV4ID4gMCAmJlxuICAgICAgICBmb3JtYXRTdHJpbmcubGVuZ3RoID4gZnAuaW5kZXgrMiAmJlxuICAgICAgICBmb3JtYXRTdHJpbmdbZnAuaW5kZXgtMV0gPT09ICdcIicgJiZcbiAgICAgICAgZm9ybWF0U3RyaW5nW2ZwLmluZGV4KzJdID09PSAnXCInXG4gICAgICApe1xuICAgICAgICBmb3JtYXRTdHJpbmdbZnAuaW5kZXgtMV0gPSBcIiBcIjtcbiAgICAgICAgZm9ybWF0U3RyaW5nW2ZwLmluZGV4KzJdID0gXCIgXCI7XG4gICAgICB9XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4gdXRpbC5mb3JtYXQoZm9ybWF0U3RyaW5nLCAuLi5wYXJhbXMpO1xufVxuXG5wYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3cgPSBmdW5jdGlvbiBmKGVyciwgY2FsbGJhY2spIHtcbiAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrKGVycik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRocm93IChlcnIpO1xufTtcblxucGFyc2VyLmV4dHJhY3RfdHlwZSA9IGZ1bmN0aW9uIGYodmFsKSB7XG4gIC8vIGRlY29tcG9zZSBjb21wb3NpdGUgdHlwZXNcbiAgY29uc3QgZGVjb21wb3NlZCA9IHZhbCA/IHZhbC5yZXBsYWNlKC9bXFxzXS9nLCAnJykuc3BsaXQoL1s8LD5dL2cpIDogWycnXTtcblxuICBmb3IgKGxldCBkID0gMDsgZCA8IGRlY29tcG9zZWQubGVuZ3RoOyBkKyspIHtcbiAgICBpZiAoXy5oYXMoZGF0YXR5cGVzLCBkZWNvbXBvc2VkW2RdKSkge1xuICAgICAgcmV0dXJuIGRlY29tcG9zZWRbZF07XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHZhbDtcbn07XG5cbnBhcnNlci5leHRyYWN0X3R5cGVEZWYgPSBmdW5jdGlvbiBmKHZhbCkge1xuICAvLyBkZWNvbXBvc2UgY29tcG9zaXRlIHR5cGVzXG4gIGxldCBkZWNvbXBvc2VkID0gdmFsID8gdmFsLnJlcGxhY2UoL1tcXHNdL2csICcnKSA6ICcnO1xuICBkZWNvbXBvc2VkID0gZGVjb21wb3NlZC5zdWJzdHIoZGVjb21wb3NlZC5pbmRleE9mKCc8JyksIGRlY29tcG9zZWQubGVuZ3RoIC0gZGVjb21wb3NlZC5pbmRleE9mKCc8JykpO1xuXG4gIHJldHVybiBkZWNvbXBvc2VkO1xufTtcblxucGFyc2VyLmV4dHJhY3RfYWx0ZXJlZF90eXBlID0gZnVuY3Rpb24gZihub3JtYWxpemVkTW9kZWxTY2hlbWEsIGRpZmYpIHtcbiAgY29uc3QgZmllbGROYW1lID0gZGlmZi5wYXRoWzBdO1xuICBsZXQgdHlwZSA9ICcnO1xuICBpZiAoZGlmZi5wYXRoLmxlbmd0aCA+IDEpIHtcbiAgICBpZiAoZGlmZi5wYXRoWzFdID09PSAndHlwZScpIHtcbiAgICAgIHR5cGUgPSBkaWZmLnJocztcbiAgICAgIGlmIChub3JtYWxpemVkTW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZURlZikge1xuICAgICAgICB0eXBlICs9IG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlRGVmO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0eXBlID0gbm9ybWFsaXplZE1vZGVsU2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGU7XG4gICAgICB0eXBlICs9IGRpZmYucmhzO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB0eXBlID0gZGlmZi5yaHMudHlwZTtcbiAgICBpZiAoZGlmZi5yaHMudHlwZURlZikgdHlwZSArPSBkaWZmLnJocy50eXBlRGVmO1xuICB9XG4gIHJldHVybiB0eXBlO1xufTtcblxucGFyc2VyLmdldF9kYl92YWx1ZV9leHByZXNzaW9uID0gZnVuY3Rpb24gZihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSkge1xuICBpZiAoZmllbGRWYWx1ZSA9PSBudWxsIHx8IGZpZWxkVmFsdWUgPT09IGNxbC50eXBlcy51bnNldCkge1xuICAgIHJldHVybiB7IHF1ZXJ5X3NlZ21lbnQ6ICc/JywgcGFyYW1ldGVyOiBmaWVsZFZhbHVlIH07XG4gIH1cblxuICBpZiAoXy5pc1BsYWluT2JqZWN0KGZpZWxkVmFsdWUpICYmIGZpZWxkVmFsdWUuJGRiX2Z1bmN0aW9uKSB7XG4gICAgcmV0dXJuIGZpZWxkVmFsdWUuJGRiX2Z1bmN0aW9uO1xuICB9XG5cbiAgY29uc3QgZmllbGRUeXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG4gIGNvbnN0IHZhbGlkYXRvcnMgPSBzY2hlbWVyLmdldF92YWxpZGF0b3JzKHNjaGVtYSwgZmllbGROYW1lKTtcblxuICBpZiAoXy5pc0FycmF5KGZpZWxkVmFsdWUpICYmIGZpZWxkVHlwZSAhPT0gJ2xpc3QnICYmIGZpZWxkVHlwZSAhPT0gJ3NldCcgJiYgZmllbGRUeXBlICE9PSAnZnJvemVuJykge1xuICAgIGNvbnN0IHZhbCA9IGZpZWxkVmFsdWUubWFwKCh2KSA9PiB7XG4gICAgICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZSwgdik7XG5cbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHJldHVybiBkYlZhbC5wYXJhbWV0ZXI7XG4gICAgICByZXR1cm4gZGJWYWw7XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBxdWVyeV9zZWdtZW50OiAnPycsIHBhcmFtZXRlcjogdmFsIH07XG4gIH1cblxuICBjb25zdCB2YWxpZGF0aW9uTWVzc2FnZSA9IHNjaGVtZXIuZ2V0X3ZhbGlkYXRpb25fbWVzc2FnZSh2YWxpZGF0b3JzLCBmaWVsZFZhbHVlKTtcbiAgaWYgKHR5cGVvZiB2YWxpZGF0aW9uTWVzc2FnZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHZhbHVlJywgdmFsaWRhdGlvbk1lc3NhZ2UoZmllbGRWYWx1ZSwgZmllbGROYW1lLCBmaWVsZFR5cGUpKSk7XG4gIH1cblxuICBpZiAoZmllbGRUeXBlID09PSAnY291bnRlcicpIHtcbiAgICBsZXQgY291bnRlclF1ZXJ5U2VnbWVudCA9IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCInLCBmaWVsZE5hbWUpO1xuICAgIGlmIChmaWVsZFZhbHVlID49IDApIGNvdW50ZXJRdWVyeVNlZ21lbnQgKz0gJyArID8nO1xuICAgIGVsc2UgY291bnRlclF1ZXJ5U2VnbWVudCArPSAnIC0gPyc7XG4gICAgZmllbGRWYWx1ZSA9IE1hdGguYWJzKGZpZWxkVmFsdWUpO1xuICAgIHJldHVybiB7IHF1ZXJ5X3NlZ21lbnQ6IGNvdW50ZXJRdWVyeVNlZ21lbnQsIHBhcmFtZXRlcjogZmllbGRWYWx1ZSB9O1xuICB9XG5cbiAgcmV0dXJuIHsgcXVlcnlfc2VnbWVudDogJz8nLCBwYXJhbWV0ZXI6IGZpZWxkVmFsdWUgfTtcbn07XG5cbnBhcnNlci51bnNldF9ub3RfYWxsb3dlZCA9IGZ1bmN0aW9uIGYob3BlcmF0aW9uLCBzY2hlbWEsIGZpZWxkTmFtZSwgY2FsbGJhY2spIHtcbiAgaWYgKHNjaGVtZXIuaXNfcHJpbWFyeV9rZXlfZmllbGQoc2NoZW1hLCBmaWVsZE5hbWUpKSB7XG4gICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGJ1aWxkRXJyb3IoYG1vZGVsLiR7b3BlcmF0aW9ufS51bnNldGtleWAsIGZpZWxkTmFtZSksIGNhbGxiYWNrKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAoc2NoZW1lci5pc19yZXF1aXJlZF9maWVsZChzY2hlbWEsIGZpZWxkTmFtZSkpIHtcbiAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coYnVpbGRFcnJvcihgbW9kZWwuJHtvcGVyYXRpb259LnVuc2V0cmVxdWlyZWRgLCBmaWVsZE5hbWUpLCBjYWxsYmFjayk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufTtcblxucGFyc2VyLmdldF9pbnBsYWNlX3VwZGF0ZV9leHByZXNzaW9uID0gZnVuY3Rpb24gZihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSwgdXBkYXRlQ2xhdXNlcywgcXVlcnlQYXJhbXMpIHtcbiAgY29uc3QgJGFkZCA9IChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kYWRkKSB8fCBmYWxzZTtcbiAgY29uc3QgJGFwcGVuZCA9IChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kYXBwZW5kKSB8fCBmYWxzZTtcbiAgY29uc3QgJHByZXBlbmQgPSAoXy5pc1BsYWluT2JqZWN0KGZpZWxkVmFsdWUpICYmIGZpZWxkVmFsdWUuJHByZXBlbmQpIHx8IGZhbHNlO1xuICBjb25zdCAkcmVwbGFjZSA9IChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kcmVwbGFjZSkgfHwgZmFsc2U7XG4gIGNvbnN0ICRyZW1vdmUgPSAoXy5pc1BsYWluT2JqZWN0KGZpZWxkVmFsdWUpICYmIGZpZWxkVmFsdWUuJHJlbW92ZSkgfHwgZmFsc2U7XG5cbiAgZmllbGRWYWx1ZSA9ICRhZGQgfHwgJGFwcGVuZCB8fCAkcHJlcGVuZCB8fCAkcmVwbGFjZSB8fCAkcmVtb3ZlIHx8IGZpZWxkVmFsdWU7XG5cbiAgY29uc3QgZGJWYWwgPSBwYXJzZXIuZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24oc2NoZW1hLCBmaWVsZE5hbWUsIGZpZWxkVmFsdWUpO1xuXG4gIGlmICghXy5pc1BsYWluT2JqZWN0KGRiVmFsKSB8fCAhZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgIHVwZGF0ZUNsYXVzZXMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiPSVzJywgZmllbGROYW1lLCBkYlZhbCkpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGZpZWxkVHlwZSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBmaWVsZE5hbWUpO1xuXG4gIGlmIChbJ21hcCcsICdsaXN0JywgJ3NldCddLmluY2x1ZGVzKGZpZWxkVHlwZSkpIHtcbiAgICBpZiAoJGFkZCB8fCAkYXBwZW5kKSB7XG4gICAgICBkYlZhbC5xdWVyeV9zZWdtZW50ID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIiArICVzJywgZmllbGROYW1lLCBkYlZhbC5xdWVyeV9zZWdtZW50KTtcbiAgICB9IGVsc2UgaWYgKCRwcmVwZW5kKSB7XG4gICAgICBpZiAoZmllbGRUeXBlID09PSAnbGlzdCcpIHtcbiAgICAgICAgZGJWYWwucXVlcnlfc2VnbWVudCA9IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCclcyArIFwiJXNcIicsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQsIGZpZWxkTmFtZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcihcbiAgICAgICAgICAnbW9kZWwudXBkYXRlLmludmFsaWRwcmVwZW5kb3AnLFxuICAgICAgICAgIHV0aWwuZm9ybWF0KCclcyBkYXRhdHlwZXMgZG9lcyBub3Qgc3VwcG9ydCAkcHJlcGVuZCwgdXNlICRhZGQgaW5zdGVhZCcsIGZpZWxkVHlwZSksXG4gICAgICAgICkpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoJHJlbW92ZSkge1xuICAgICAgZGJWYWwucXVlcnlfc2VnbWVudCA9IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCIgLSAlcycsIGZpZWxkTmFtZSwgZGJWYWwucXVlcnlfc2VnbWVudCk7XG4gICAgICBpZiAoZmllbGRUeXBlID09PSAnbWFwJykgZGJWYWwucGFyYW1ldGVyID0gT2JqZWN0LmtleXMoZGJWYWwucGFyYW1ldGVyKTtcbiAgICB9XG4gIH1cblxuICBpZiAoJHJlcGxhY2UpIHtcbiAgICBpZiAoZmllbGRUeXBlID09PSAnbWFwJykge1xuICAgICAgdXBkYXRlQ2xhdXNlcy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCJbP109JXMnLCBmaWVsZE5hbWUsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpKTtcbiAgICAgIGNvbnN0IHJlcGxhY2VLZXlzID0gT2JqZWN0LmtleXMoZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgIGNvbnN0IHJlcGxhY2VWYWx1ZXMgPSBfLnZhbHVlcyhkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgaWYgKHJlcGxhY2VLZXlzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKHJlcGxhY2VLZXlzWzBdKTtcbiAgICAgICAgcXVlcnlQYXJhbXMucHVzaChyZXBsYWNlVmFsdWVzWzBdKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IChcbiAgICAgICAgICBidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuaW52YWxpZHJlcGxhY2VvcCcsICckcmVwbGFjZSBpbiBtYXAgZG9lcyBub3Qgc3VwcG9ydCBtb3JlIHRoYW4gb25lIGl0ZW0nKVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoZmllbGRUeXBlID09PSAnbGlzdCcpIHtcbiAgICAgIHVwZGF0ZUNsYXVzZXMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiWz9dPSVzJywgZmllbGROYW1lLCBkYlZhbC5xdWVyeV9zZWdtZW50KSk7XG4gICAgICBpZiAoZGJWYWwucGFyYW1ldGVyLmxlbmd0aCA9PT0gMikge1xuICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlclswXSk7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyWzFdKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKFxuICAgICAgICAgICdtb2RlbC51cGRhdGUuaW52YWxpZHJlcGxhY2VvcCcsXG4gICAgICAgICAgJyRyZXBsYWNlIGluIGxpc3Qgc2hvdWxkIGhhdmUgZXhhY3RseSAyIGl0ZW1zLCBmaXJzdCBvbmUgYXMgdGhlIGluZGV4IGFuZCB0aGUgc2Vjb25kIG9uZSBhcyB0aGUgdmFsdWUnLFxuICAgICAgICApKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoXG4gICAgICAgICdtb2RlbC51cGRhdGUuaW52YWxpZHJlcGxhY2VvcCcsXG4gICAgICAgIHV0aWwuZm9ybWF0KCclcyBkYXRhdHlwZXMgZG9lcyBub3Qgc3VwcG9ydCAkcmVwbGFjZScsIGZpZWxkVHlwZSksXG4gICAgICApKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgdXBkYXRlQ2xhdXNlcy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCI9JXMnLCBmaWVsZE5hbWUsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpKTtcbiAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gIH1cbn07XG5cbnBhcnNlci5nZXRfdXBkYXRlX3ZhbHVlX2V4cHJlc3Npb24gPSBmdW5jdGlvbiBmKGluc3RhbmNlLCBzY2hlbWEsIHVwZGF0ZVZhbHVlcywgY2FsbGJhY2spIHtcbiAgY29uc3QgdXBkYXRlQ2xhdXNlcyA9IFtdO1xuICBjb25zdCBxdWVyeVBhcmFtcyA9IFtdO1xuXG4gIGlmIChzY2hlbWEub3B0aW9ucyAmJiBzY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzKSB7XG4gICAgaWYgKCF1cGRhdGVWYWx1ZXNbc2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy51cGRhdGVkQXRdKSB7XG4gICAgICB1cGRhdGVWYWx1ZXNbc2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy51cGRhdGVkQXRdID0geyAkZGJfZnVuY3Rpb246ICd0b1RpbWVzdGFtcChub3coKSknIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKHNjaGVtYS5vcHRpb25zICYmIHNjaGVtYS5vcHRpb25zLnZlcnNpb25zKSB7XG4gICAgaWYgKCF1cGRhdGVWYWx1ZXNbc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5XSkge1xuICAgICAgdXBkYXRlVmFsdWVzW3NjaGVtYS5vcHRpb25zLnZlcnNpb25zLmtleV0gPSB7ICRkYl9mdW5jdGlvbjogJ25vdygpJyB9O1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGVycm9ySGFwcGVuZWQgPSBPYmplY3Qua2V5cyh1cGRhdGVWYWx1ZXMpLnNvbWUoKGZpZWxkTmFtZSkgPT4ge1xuICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gPT09IHVuZGVmaW5lZCB8fCBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udmlydHVhbCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgY29uc3QgZmllbGRUeXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG4gICAgbGV0IGZpZWxkVmFsdWUgPSB1cGRhdGVWYWx1ZXNbZmllbGROYW1lXTtcblxuICAgIGlmIChmaWVsZFZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGZpZWxkVmFsdWUgPSBpbnN0YW5jZS5fZ2V0X2RlZmF1bHRfdmFsdWUoZmllbGROYW1lKTtcbiAgICAgIGlmIChmaWVsZFZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIHBhcnNlci51bnNldF9ub3RfYWxsb3dlZCgndXBkYXRlJywgc2NoZW1hLCBmaWVsZE5hbWUsIGNhbGxiYWNrKTtcbiAgICAgIH0gZWxzZSBpZiAoIXNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5ydWxlIHx8ICFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0ucnVsZS5pZ25vcmVfZGVmYXVsdCkge1xuICAgICAgICAvLyBkaWQgc2V0IGEgZGVmYXVsdCB2YWx1ZSwgaWdub3JlIGRlZmF1bHQgaXMgbm90IHNldFxuICAgICAgICBpZiAoaW5zdGFuY2UudmFsaWRhdGUoZmllbGROYW1lLCBmaWVsZFZhbHVlKSAhPT0gdHJ1ZSkge1xuICAgICAgICAgIHBhcnNlci5jYWxsYmFja19vcl90aHJvdyhidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuaW52YWxpZGRlZmF1bHR2YWx1ZScsIGZpZWxkVmFsdWUsIGZpZWxkTmFtZSwgZmllbGRUeXBlKSwgY2FsbGJhY2spO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUgPT09IG51bGwgfHwgZmllbGRWYWx1ZSA9PT0gY3FsLnR5cGVzLnVuc2V0KSB7XG4gICAgICBpZiAocGFyc2VyLnVuc2V0X25vdF9hbGxvd2VkKCd1cGRhdGUnLCBzY2hlbWEsIGZpZWxkTmFtZSwgY2FsbGJhY2spKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBwYXJzZXIuZ2V0X2lucGxhY2VfdXBkYXRlX2V4cHJlc3Npb24oc2NoZW1hLCBmaWVsZE5hbWUsIGZpZWxkVmFsdWUsIHVwZGF0ZUNsYXVzZXMsIHF1ZXJ5UGFyYW1zKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coZSwgY2FsbGJhY2spO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSk7XG5cbiAgcmV0dXJuIHsgdXBkYXRlQ2xhdXNlcywgcXVlcnlQYXJhbXMsIGVycm9ySGFwcGVuZWQgfTtcbn07XG5cbnBhcnNlci5nZXRfc2F2ZV92YWx1ZV9leHByZXNzaW9uID0gZnVuY3Rpb24gZm4oaW5zdGFuY2UsIHNjaGVtYSwgY2FsbGJhY2spIHtcbiAgY29uc3QgaWRlbnRpZmllcnMgPSBbXTtcbiAgY29uc3QgdmFsdWVzID0gW107XG4gIGNvbnN0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgaWYgKHNjaGVtYS5vcHRpb25zICYmIHNjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMpIHtcbiAgICBpZiAoaW5zdGFuY2Vbc2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy51cGRhdGVkQXRdKSB7XG4gICAgICBpbnN0YW5jZVtzY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzLnVwZGF0ZWRBdF0gPSB7ICRkYl9mdW5jdGlvbjogJ3RvVGltZXN0YW1wKG5vdygpKScgfTtcbiAgICB9XG4gIH1cblxuICBpZiAoc2NoZW1hLm9wdGlvbnMgJiYgc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMpIHtcbiAgICBpZiAoaW5zdGFuY2Vbc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5XSkge1xuICAgICAgaW5zdGFuY2Vbc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5XSA9IHsgJGRiX2Z1bmN0aW9uOiAnbm93KCknIH07XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZXJyb3JIYXBwZW5lZCA9IE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpLnNvbWUoKGZpZWxkTmFtZSkgPT4ge1xuICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udmlydHVhbCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgLy8gY2hlY2sgZmllbGQgdmFsdWVcbiAgICBjb25zdCBmaWVsZFR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwgZmllbGROYW1lKTtcbiAgICBsZXQgZmllbGRWYWx1ZSA9IGluc3RhbmNlW2ZpZWxkTmFtZV07XG5cbiAgICBpZiAoZmllbGRWYWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBmaWVsZFZhbHVlID0gaW5zdGFuY2UuX2dldF9kZWZhdWx0X3ZhbHVlKGZpZWxkTmFtZSk7XG4gICAgICBpZiAoZmllbGRWYWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJldHVybiBwYXJzZXIudW5zZXRfbm90X2FsbG93ZWQoJ3NhdmUnLCBzY2hlbWEsIGZpZWxkTmFtZSwgY2FsbGJhY2spO1xuICAgICAgfSBlbHNlIGlmICghc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnJ1bGUgfHwgIXNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5ydWxlLmlnbm9yZV9kZWZhdWx0KSB7XG4gICAgICAgIC8vIGRpZCBzZXQgYSBkZWZhdWx0IHZhbHVlLCBpZ25vcmUgZGVmYXVsdCBpcyBub3Qgc2V0XG4gICAgICAgIGlmIChpbnN0YW5jZS52YWxpZGF0ZShmaWVsZE5hbWUsIGZpZWxkVmFsdWUpICE9PSB0cnVlKSB7XG4gICAgICAgICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuaW52YWxpZGRlZmF1bHR2YWx1ZScsIGZpZWxkVmFsdWUsIGZpZWxkTmFtZSwgZmllbGRUeXBlKSwgY2FsbGJhY2spO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUgPT09IG51bGwgfHwgZmllbGRWYWx1ZSA9PT0gY3FsLnR5cGVzLnVuc2V0KSB7XG4gICAgICBpZiAocGFyc2VyLnVuc2V0X25vdF9hbGxvd2VkKCdzYXZlJywgc2NoZW1hLCBmaWVsZE5hbWUsIGNhbGxiYWNrKSkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZGVudGlmaWVycy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCInLCBmaWVsZE5hbWUpKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGRiVmFsKSAmJiBkYlZhbC5xdWVyeV9zZWdtZW50KSB7XG4gICAgICAgIHZhbHVlcy5wdXNoKGRiVmFsLnF1ZXJ5X3NlZ21lbnQpO1xuICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YWx1ZXMucHVzaChkYlZhbCk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGUsIGNhbGxiYWNrKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH0pO1xuXG4gIHJldHVybiB7XG4gICAgaWRlbnRpZmllcnMsXG4gICAgdmFsdWVzLFxuICAgIHF1ZXJ5UGFyYW1zLFxuICAgIGVycm9ySGFwcGVuZWQsXG4gIH07XG59O1xuXG5wYXJzZXIuZXh0cmFjdF9xdWVyeV9yZWxhdGlvbnMgPSBmdW5jdGlvbiBmKGZpZWxkTmFtZSwgcmVsYXRpb25LZXksIHJlbGF0aW9uVmFsdWUsIHNjaGVtYSwgdmFsaWRPcGVyYXRvcnMpIHtcbiAgY29uc3QgcXVlcnlSZWxhdGlvbnMgPSBbXTtcbiAgY29uc3QgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBpZiAoIV8uaGFzKHZhbGlkT3BlcmF0b3JzLCByZWxhdGlvbktleS50b0xvd2VyQ2FzZSgpKSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRvcCcsIHJlbGF0aW9uS2V5KSk7XG4gIH1cblxuICByZWxhdGlvbktleSA9IHJlbGF0aW9uS2V5LnRvTG93ZXJDYXNlKCk7XG4gIGlmIChyZWxhdGlvbktleSA9PT0gJyRpbicgJiYgIV8uaXNBcnJheShyZWxhdGlvblZhbHVlKSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRpbm9wJykpO1xuICB9XG4gIGlmIChyZWxhdGlvbktleSA9PT0gJyR0b2tlbicgJiYgIShyZWxhdGlvblZhbHVlIGluc3RhbmNlb2YgT2JqZWN0KSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWR0b2tlbicpKTtcbiAgfVxuXG4gIGxldCBvcGVyYXRvciA9IHZhbGlkT3BlcmF0b3JzW3JlbGF0aW9uS2V5XTtcbiAgbGV0IHdoZXJlVGVtcGxhdGUgPSAnXCIlc1wiICVzICVzJztcblxuICBjb25zdCBidWlsZFF1ZXJ5UmVsYXRpb25zID0gKGZpZWxkTmFtZUxvY2FsLCByZWxhdGlvblZhbHVlTG9jYWwpID0+IHtcbiAgICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZUxvY2FsLCByZWxhdGlvblZhbHVlTG9jYWwpO1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHtcbiAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoXG4gICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgIGZpZWxkTmFtZUxvY2FsLCBvcGVyYXRvciwgZGJWYWwucXVlcnlfc2VnbWVudCxcbiAgICAgICkpO1xuICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKFxuICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICBmaWVsZE5hbWVMb2NhbCwgb3BlcmF0b3IsIGRiVmFsLFxuICAgICAgKSk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGJ1aWxkVG9rZW5RdWVyeVJlbGF0aW9ucyA9ICh0b2tlblJlbGF0aW9uS2V5LCB0b2tlblJlbGF0aW9uVmFsdWUpID0+IHtcbiAgICB0b2tlblJlbGF0aW9uS2V5ID0gdG9rZW5SZWxhdGlvbktleS50b0xvd2VyQ2FzZSgpO1xuICAgIGlmIChfLmhhcyh2YWxpZE9wZXJhdG9ycywgdG9rZW5SZWxhdGlvbktleSkgJiYgdG9rZW5SZWxhdGlvbktleSAhPT0gJyR0b2tlbicgJiYgdG9rZW5SZWxhdGlvbktleSAhPT0gJyRpbicpIHtcbiAgICAgIG9wZXJhdG9yID0gdmFsaWRPcGVyYXRvcnNbdG9rZW5SZWxhdGlvbktleV07XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWR0b2tlbm9wJywgdG9rZW5SZWxhdGlvbktleSkpO1xuICAgIH1cblxuICAgIGlmIChfLmlzQXJyYXkodG9rZW5SZWxhdGlvblZhbHVlKSkge1xuICAgICAgY29uc3QgdG9rZW5LZXlzID0gZmllbGROYW1lLnNwbGl0KCcsJyk7XG4gICAgICBmb3IgKGxldCB0b2tlbkluZGV4ID0gMDsgdG9rZW5JbmRleCA8IHRva2VuUmVsYXRpb25WYWx1ZS5sZW5ndGg7IHRva2VuSW5kZXgrKykge1xuICAgICAgICB0b2tlbktleXNbdG9rZW5JbmRleF0gPSB0b2tlbktleXNbdG9rZW5JbmRleF0udHJpbSgpO1xuICAgICAgICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIHRva2VuS2V5c1t0b2tlbkluZGV4XSwgdG9rZW5SZWxhdGlvblZhbHVlW3Rva2VuSW5kZXhdKTtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgICAgICAgIHRva2VuUmVsYXRpb25WYWx1ZVt0b2tlbkluZGV4XSA9IGRiVmFsLnF1ZXJ5X3NlZ21lbnQ7XG4gICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRva2VuUmVsYXRpb25WYWx1ZVt0b2tlbkluZGV4XSA9IGRiVmFsO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICB0b2tlbktleXMuam9pbignXCIsXCInKSwgb3BlcmF0b3IsIHRva2VuUmVsYXRpb25WYWx1ZS50b1N0cmluZygpLFxuICAgICAgKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGJ1aWxkUXVlcnlSZWxhdGlvbnMoZmllbGROYW1lLCB0b2tlblJlbGF0aW9uVmFsdWUpO1xuICAgIH1cbiAgfTtcblxuICBpZiAocmVsYXRpb25LZXkgPT09ICckdG9rZW4nKSB7XG4gICAgd2hlcmVUZW1wbGF0ZSA9ICd0b2tlbihcIiVzXCIpICVzIHRva2VuKCVzKSc7XG5cbiAgICBjb25zdCB0b2tlblJlbGF0aW9uS2V5cyA9IE9iamVjdC5rZXlzKHJlbGF0aW9uVmFsdWUpO1xuICAgIGZvciAobGV0IHRva2VuUksgPSAwOyB0b2tlblJLIDwgdG9rZW5SZWxhdGlvbktleXMubGVuZ3RoOyB0b2tlblJLKyspIHtcbiAgICAgIGNvbnN0IHRva2VuUmVsYXRpb25LZXkgPSB0b2tlblJlbGF0aW9uS2V5c1t0b2tlblJLXTtcbiAgICAgIGNvbnN0IHRva2VuUmVsYXRpb25WYWx1ZSA9IHJlbGF0aW9uVmFsdWVbdG9rZW5SZWxhdGlvbktleV07XG4gICAgICBidWlsZFRva2VuUXVlcnlSZWxhdGlvbnModG9rZW5SZWxhdGlvbktleSwgdG9rZW5SZWxhdGlvblZhbHVlKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAocmVsYXRpb25LZXkgPT09ICckY29udGFpbnMnKSB7XG4gICAgY29uc3QgZmllbGRUeXBlMSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBmaWVsZE5hbWUpO1xuICAgIGlmIChbJ21hcCcsICdsaXN0JywgJ3NldCcsICdmcm96ZW4nXS5pbmNsdWRlcyhmaWVsZFR5cGUxKSkge1xuICAgICAgaWYgKGZpZWxkVHlwZTEgPT09ICdtYXAnICYmIF8uaXNQbGFpbk9iamVjdChyZWxhdGlvblZhbHVlKSkge1xuICAgICAgICBPYmplY3Qua2V5cyhyZWxhdGlvblZhbHVlKS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKFxuICAgICAgICAgICAgJ1wiJXNcIlslc10gJXMgJXMnLFxuICAgICAgICAgICAgZmllbGROYW1lLCAnPycsICc9JywgJz8nLFxuICAgICAgICAgICkpO1xuICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goa2V5KTtcbiAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKHJlbGF0aW9uVmFsdWVba2V5XSk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZShcbiAgICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICAgIGZpZWxkTmFtZSwgb3BlcmF0b3IsICc/JyxcbiAgICAgICAgKSk7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2gocmVsYXRpb25WYWx1ZSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRjb250YWluc29wJykpO1xuICAgIH1cbiAgfSBlbHNlIGlmIChyZWxhdGlvbktleSA9PT0gJyRjb250YWluc19rZXknKSB7XG4gICAgY29uc3QgZmllbGRUeXBlMiA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBmaWVsZE5hbWUpO1xuICAgIGlmIChmaWVsZFR5cGUyICE9PSAnbWFwJykge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZGNvbnRhaW5za2V5b3AnKSk7XG4gICAgfVxuICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgZmllbGROYW1lLCBvcGVyYXRvciwgJz8nLFxuICAgICkpO1xuICAgIHF1ZXJ5UGFyYW1zLnB1c2gocmVsYXRpb25WYWx1ZSk7XG4gIH0gZWxzZSB7XG4gICAgYnVpbGRRdWVyeVJlbGF0aW9ucyhmaWVsZE5hbWUsIHJlbGF0aW9uVmFsdWUpO1xuICB9XG4gIHJldHVybiB7IHF1ZXJ5UmVsYXRpb25zLCBxdWVyeVBhcmFtcyB9O1xufTtcblxucGFyc2VyLl9wYXJzZV9xdWVyeV9vYmplY3QgPSBmdW5jdGlvbiBmKHNjaGVtYSwgcXVlcnlPYmplY3QpIHtcbiAgbGV0IHF1ZXJ5UmVsYXRpb25zID0gW107XG4gIGxldCBxdWVyeVBhcmFtcyA9IFtdO1xuXG4gIE9iamVjdC5rZXlzKHF1ZXJ5T2JqZWN0KS5mb3JFYWNoKChmaWVsZE5hbWUpID0+IHtcbiAgICBpZiAoZmllbGROYW1lLnN0YXJ0c1dpdGgoJyQnKSkge1xuICAgICAgLy8gc2VhcmNoIHF1ZXJpZXMgYmFzZWQgb24gbHVjZW5lIGluZGV4IG9yIHNvbHJcbiAgICAgIC8vIGVzY2FwZSBhbGwgc2luZ2xlIHF1b3RlcyBmb3IgcXVlcmllcyBpbiBjYXNzYW5kcmFcbiAgICAgIGlmIChmaWVsZE5hbWUgPT09ICckZXhwcicpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBxdWVyeU9iamVjdFtmaWVsZE5hbWVdLmluZGV4ID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgcXVlcnlPYmplY3RbZmllbGROYW1lXS5xdWVyeSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgXCJleHByKCVzLCclcycpXCIsXG4gICAgICAgICAgICBxdWVyeU9iamVjdFtmaWVsZE5hbWVdLmluZGV4LCBxdWVyeU9iamVjdFtmaWVsZE5hbWVdLnF1ZXJ5LnJlcGxhY2UoLycvZywgXCInJ1wiKSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkZXhwcicpKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChmaWVsZE5hbWUgPT09ICckc29scl9xdWVyeScpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBxdWVyeU9iamVjdFtmaWVsZE5hbWVdID09PSAnc3RyaW5nJykge1xuICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgICAgICBcInNvbHJfcXVlcnk9JyVzJ1wiLFxuICAgICAgICAgICAgcXVlcnlPYmplY3RbZmllbGROYW1lXS5yZXBsYWNlKC8nL2csIFwiJydcIiksXG4gICAgICAgICAgKSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZHNvbHJxdWVyeScpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxldCB3aGVyZU9iamVjdCA9IHF1ZXJ5T2JqZWN0W2ZpZWxkTmFtZV07XG4gICAgLy8gQXJyYXkgb2Ygb3BlcmF0b3JzXG4gICAgaWYgKCFfLmlzQXJyYXkod2hlcmVPYmplY3QpKSB3aGVyZU9iamVjdCA9IFt3aGVyZU9iamVjdF07XG5cbiAgICBmb3IgKGxldCBmayA9IDA7IGZrIDwgd2hlcmVPYmplY3QubGVuZ3RoOyBmaysrKSB7XG4gICAgICBsZXQgZmllbGRSZWxhdGlvbiA9IHdoZXJlT2JqZWN0W2ZrXTtcblxuICAgICAgY29uc3QgY3FsT3BlcmF0b3JzID0ge1xuICAgICAgICAkZXE6ICc9JyxcbiAgICAgICAgJG5lOiAnIT0nLFxuICAgICAgICAkaXNudDogJ0lTIE5PVCcsXG4gICAgICAgICRndDogJz4nLFxuICAgICAgICAkbHQ6ICc8JyxcbiAgICAgICAgJGd0ZTogJz49JyxcbiAgICAgICAgJGx0ZTogJzw9JyxcbiAgICAgICAgJGluOiAnSU4nLFxuICAgICAgICAkbGlrZTogJ0xJS0UnLFxuICAgICAgICAkdG9rZW46ICd0b2tlbicsXG4gICAgICAgICRjb250YWluczogJ0NPTlRBSU5TJyxcbiAgICAgICAgJGNvbnRhaW5zX2tleTogJ0NPTlRBSU5TIEtFWScsXG4gICAgICB9O1xuXG4gICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGZpZWxkUmVsYXRpb24pKSB7XG4gICAgICAgIGNvbnN0IHZhbGlkS2V5cyA9IE9iamVjdC5rZXlzKGNxbE9wZXJhdG9ycyk7XG4gICAgICAgIGNvbnN0IGZpZWxkUmVsYXRpb25LZXlzID0gT2JqZWN0LmtleXMoZmllbGRSZWxhdGlvbik7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZmllbGRSZWxhdGlvbktleXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICBpZiAoIXZhbGlkS2V5cy5pbmNsdWRlcyhmaWVsZFJlbGF0aW9uS2V5c1tpXSkpIHtcbiAgICAgICAgICAgIC8vIGZpZWxkIHJlbGF0aW9uIGtleSBpbnZhbGlkLCBhcHBseSBkZWZhdWx0ICRlcSBvcGVyYXRvclxuICAgICAgICAgICAgZmllbGRSZWxhdGlvbiA9IHsgJGVxOiBmaWVsZFJlbGF0aW9uIH07XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZpZWxkUmVsYXRpb24gPSB7ICRlcTogZmllbGRSZWxhdGlvbiB9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCByZWxhdGlvbktleXMgPSBPYmplY3Qua2V5cyhmaWVsZFJlbGF0aW9uKTtcbiAgICAgIGZvciAobGV0IHJrID0gMDsgcmsgPCByZWxhdGlvbktleXMubGVuZ3RoOyByaysrKSB7XG4gICAgICAgIGNvbnN0IHJlbGF0aW9uS2V5ID0gcmVsYXRpb25LZXlzW3JrXTtcbiAgICAgICAgY29uc3QgcmVsYXRpb25WYWx1ZSA9IGZpZWxkUmVsYXRpb25bcmVsYXRpb25LZXldO1xuICAgICAgICBjb25zdCBleHRyYWN0ZWRSZWxhdGlvbnMgPSBwYXJzZXIuZXh0cmFjdF9xdWVyeV9yZWxhdGlvbnMoXG4gICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgIHJlbGF0aW9uS2V5LFxuICAgICAgICAgIHJlbGF0aW9uVmFsdWUsXG4gICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgIGNxbE9wZXJhdG9ycyxcbiAgICAgICAgKTtcbiAgICAgICAgcXVlcnlSZWxhdGlvbnMgPSBxdWVyeVJlbGF0aW9ucy5jb25jYXQoZXh0cmFjdGVkUmVsYXRpb25zLnF1ZXJ5UmVsYXRpb25zKTtcbiAgICAgICAgcXVlcnlQYXJhbXMgPSBxdWVyeVBhcmFtcy5jb25jYXQoZXh0cmFjdGVkUmVsYXRpb25zLnF1ZXJ5UGFyYW1zKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiB7IHF1ZXJ5UmVsYXRpb25zLCBxdWVyeVBhcmFtcyB9O1xufTtcblxucGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlID0gZnVuY3Rpb24gZihzY2hlbWEsIHF1ZXJ5T2JqZWN0LCBjbGF1c2UpIHtcbiAgY29uc3QgcGFyc2VkT2JqZWN0ID0gcGFyc2VyLl9wYXJzZV9xdWVyeV9vYmplY3Qoc2NoZW1hLCBxdWVyeU9iamVjdCk7XG4gIGNvbnN0IGZpbHRlckNsYXVzZSA9IHt9O1xuICBpZiAocGFyc2VkT2JqZWN0LnF1ZXJ5UmVsYXRpb25zLmxlbmd0aCA+IDApIHtcbiAgICBmaWx0ZXJDbGF1c2UucXVlcnkgPSB1dGlsLmZvcm1hdCgnJXMgJXMnLCBjbGF1c2UsIHBhcnNlZE9iamVjdC5xdWVyeVJlbGF0aW9ucy5qb2luKCcgQU5EICcpKTtcbiAgfSBlbHNlIHtcbiAgICBmaWx0ZXJDbGF1c2UucXVlcnkgPSAnJztcbiAgfVxuICBmaWx0ZXJDbGF1c2UucGFyYW1zID0gcGFyc2VkT2JqZWN0LnF1ZXJ5UGFyYW1zO1xuICByZXR1cm4gZmlsdGVyQ2xhdXNlO1xufTtcblxucGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlX2RkbCA9IGZ1bmN0aW9uIGYoc2NoZW1hLCBxdWVyeU9iamVjdCwgY2xhdXNlKSB7XG4gIGNvbnN0IGZpbHRlckNsYXVzZSA9IHBhcnNlci5nZXRfZmlsdGVyX2NsYXVzZShzY2hlbWEsIHF1ZXJ5T2JqZWN0LCBjbGF1c2UpO1xuICBsZXQgZmlsdGVyUXVlcnkgPSBmaWx0ZXJDbGF1c2UucXVlcnk7XG4gIGZpbHRlckNsYXVzZS5wYXJhbXMuZm9yRWFjaCgocGFyYW0pID0+IHtcbiAgICBsZXQgcXVlcnlQYXJhbTtcbiAgICBpZiAodHlwZW9mIHBhcmFtID09PSAnc3RyaW5nJykge1xuICAgICAgcXVlcnlQYXJhbSA9IHV0aWwuZm9ybWF0KFwiJyVzJ1wiLCBwYXJhbSk7XG4gICAgfSBlbHNlIGlmIChwYXJhbSBpbnN0YW5jZW9mIERhdGUpIHtcbiAgICAgIHF1ZXJ5UGFyYW0gPSB1dGlsLmZvcm1hdChcIiclcydcIiwgcGFyYW0udG9JU09TdHJpbmcoKSk7XG4gICAgfSBlbHNlIGlmIChwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5Mb25nXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5JbnRlZ2VyXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5CaWdEZWNpbWFsXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5UaW1lVXVpZFxuICAgICAgfHwgcGFyYW0gaW5zdGFuY2VvZiBjcWwudHlwZXMuVXVpZCkge1xuICAgICAgcXVlcnlQYXJhbSA9IHBhcmFtLnRvU3RyaW5nKCk7XG4gICAgfSBlbHNlIGlmIChwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5Mb2NhbERhdGVcbiAgICAgIHx8IHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLkxvY2FsVGltZVxuICAgICAgfHwgcGFyYW0gaW5zdGFuY2VvZiBjcWwudHlwZXMuSW5ldEFkZHJlc3MpIHtcbiAgICAgIHF1ZXJ5UGFyYW0gPSB1dGlsLmZvcm1hdChcIiclcydcIiwgcGFyYW0udG9TdHJpbmcoKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHF1ZXJ5UGFyYW0gPSBwYXJhbTtcbiAgICB9XG4gICAgLy8gVE9ETzogdW5oYW5kbGVkIGlmIHF1ZXJ5UGFyYW0gaXMgYSBzdHJpbmcgY29udGFpbmluZyA/IGNoYXJhY3RlclxuICAgIC8vIHRob3VnaCB0aGlzIGlzIHVubGlrZWx5IHRvIGhhdmUgaW4gbWF0ZXJpYWxpemVkIHZpZXcgZmlsdGVycywgYnV0Li4uXG4gICAgZmlsdGVyUXVlcnkgPSBmaWx0ZXJRdWVyeS5yZXBsYWNlKCc/JywgcXVlcnlQYXJhbSk7XG4gIH0pO1xuICByZXR1cm4gZmlsdGVyUXVlcnk7XG59O1xuXG5wYXJzZXIuZ2V0X3doZXJlX2NsYXVzZSA9IGZ1bmN0aW9uIGYoc2NoZW1hLCBxdWVyeU9iamVjdCkge1xuICByZXR1cm4gcGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlKHNjaGVtYSwgcXVlcnlPYmplY3QsICdXSEVSRScpO1xufTtcblxucGFyc2VyLmdldF9pZl9jbGF1c2UgPSBmdW5jdGlvbiBmKHNjaGVtYSwgcXVlcnlPYmplY3QpIHtcbiAgcmV0dXJuIHBhcnNlci5nZXRfZmlsdGVyX2NsYXVzZShzY2hlbWEsIHF1ZXJ5T2JqZWN0LCAnSUYnKTtcbn07XG5cbnBhcnNlci5nZXRfcHJpbWFyeV9rZXlfY2xhdXNlcyA9IGZ1bmN0aW9uIGYoc2NoZW1hKSB7XG4gIGNvbnN0IHBhcnRpdGlvbktleSA9IHNjaGVtYS5rZXlbMF07XG4gIGxldCBjbHVzdGVyaW5nS2V5ID0gc2NoZW1hLmtleS5zbGljZSgxLCBzY2hlbWEua2V5Lmxlbmd0aCk7XG4gIGNvbnN0IGNsdXN0ZXJpbmdPcmRlciA9IFtdO1xuXG4gIGZvciAobGV0IGZpZWxkID0gMDsgZmllbGQgPCBjbHVzdGVyaW5nS2V5Lmxlbmd0aDsgZmllbGQrKykge1xuICAgIGlmIChzY2hlbWEuY2x1c3RlcmluZ19vcmRlclxuICAgICAgICAmJiBzY2hlbWEuY2x1c3RlcmluZ19vcmRlcltjbHVzdGVyaW5nS2V5W2ZpZWxkXV1cbiAgICAgICAgJiYgc2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbY2x1c3RlcmluZ0tleVtmaWVsZF1dLnRvTG93ZXJDYXNlKCkgPT09ICdkZXNjJykge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIiBERVNDJywgY2x1c3RlcmluZ0tleVtmaWVsZF0pKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIiBBU0MnLCBjbHVzdGVyaW5nS2V5W2ZpZWxkXSkpO1xuICAgIH1cbiAgfVxuXG4gIGxldCBjbHVzdGVyaW5nT3JkZXJDbGF1c2UgPSAnJztcbiAgaWYgKGNsdXN0ZXJpbmdPcmRlci5sZW5ndGggPiAwKSB7XG4gICAgY2x1c3RlcmluZ09yZGVyQ2xhdXNlID0gdXRpbC5mb3JtYXQoJyBXSVRIIENMVVNURVJJTkcgT1JERVIgQlkgKCVzKScsIGNsdXN0ZXJpbmdPcmRlci50b1N0cmluZygpKTtcbiAgfVxuXG4gIGxldCBwYXJ0aXRpb25LZXlDbGF1c2UgPSAnJztcbiAgaWYgKF8uaXNBcnJheShwYXJ0aXRpb25LZXkpKSB7XG4gICAgcGFydGl0aW9uS2V5Q2xhdXNlID0gcGFydGl0aW9uS2V5Lm1hcCgodikgPT4gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHYpKS5qb2luKCcsJyk7XG4gIH0gZWxzZSB7XG4gICAgcGFydGl0aW9uS2V5Q2xhdXNlID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHBhcnRpdGlvbktleSk7XG4gIH1cblxuICBsZXQgY2x1c3RlcmluZ0tleUNsYXVzZSA9ICcnO1xuICBpZiAoY2x1c3RlcmluZ0tleS5sZW5ndGgpIHtcbiAgICBjbHVzdGVyaW5nS2V5ID0gY2x1c3RlcmluZ0tleS5tYXAoKHYpID0+IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCInLCB2KSkuam9pbignLCcpO1xuICAgIGNsdXN0ZXJpbmdLZXlDbGF1c2UgPSB1dGlsLmZvcm1hdCgnLCVzJywgY2x1c3RlcmluZ0tleSk7XG4gIH1cblxuICByZXR1cm4geyBwYXJ0aXRpb25LZXlDbGF1c2UsIGNsdXN0ZXJpbmdLZXlDbGF1c2UsIGNsdXN0ZXJpbmdPcmRlckNsYXVzZSB9O1xufTtcblxucGFyc2VyLmdldF9tdmlld193aGVyZV9jbGF1c2UgPSBmdW5jdGlvbiBmKHNjaGVtYSwgdmlld1NjaGVtYSkge1xuICBjb25zdCBjbGF1c2VzID0gcGFyc2VyLmdldF9wcmltYXJ5X2tleV9jbGF1c2VzKHZpZXdTY2hlbWEpO1xuICBsZXQgd2hlcmVDbGF1c2UgPSBjbGF1c2VzLnBhcnRpdGlvbktleUNsYXVzZS5zcGxpdCgnLCcpLmpvaW4oJyBJUyBOT1QgTlVMTCBBTkQgJyk7XG4gIGlmIChjbGF1c2VzLmNsdXN0ZXJpbmdLZXlDbGF1c2UpIHdoZXJlQ2xhdXNlICs9IGNsYXVzZXMuY2x1c3RlcmluZ0tleUNsYXVzZS5zcGxpdCgnLCcpLmpvaW4oJyBJUyBOT1QgTlVMTCBBTkQgJyk7XG4gIHdoZXJlQ2xhdXNlICs9ICcgSVMgTk9UIE5VTEwnO1xuXG4gIGNvbnN0IGZpbHRlcnMgPSBfLmNsb25lRGVlcCh2aWV3U2NoZW1hLmZpbHRlcnMpO1xuXG4gIGlmIChfLmlzUGxhaW5PYmplY3QoZmlsdGVycykpIHtcbiAgICAvLyBkZWxldGUgcHJpbWFyeSBrZXkgZmllbGRzIGRlZmluZWQgYXMgaXNuJ3QgbnVsbCBpbiBmaWx0ZXJzXG4gICAgT2JqZWN0LmtleXMoZmlsdGVycykuZm9yRWFjaCgoZmlsdGVyS2V5KSA9PiB7XG4gICAgICBpZiAoZmlsdGVyc1tmaWx0ZXJLZXldLiRpc250ID09PSBudWxsXG4gICAgICAgICAgJiYgKHZpZXdTY2hlbWEua2V5LmluY2x1ZGVzKGZpbHRlcktleSkgfHwgdmlld1NjaGVtYS5rZXlbMF0uaW5jbHVkZXMoZmlsdGVyS2V5KSkpIHtcbiAgICAgICAgZGVsZXRlIGZpbHRlcnNbZmlsdGVyS2V5XS4kaXNudDtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGNvbnN0IGZpbHRlckNsYXVzZSA9IHBhcnNlci5nZXRfZmlsdGVyX2NsYXVzZV9kZGwoc2NoZW1hLCBmaWx0ZXJzLCAnQU5EJyk7XG4gICAgd2hlcmVDbGF1c2UgKz0gdXRpbC5mb3JtYXQoJyAlcycsIGZpbHRlckNsYXVzZSkucmVwbGFjZSgvSVMgTk9UIG51bGwvZywgJ0lTIE5PVCBOVUxMJyk7XG4gIH1cblxuICAvLyByZW1vdmUgdW5uZWNlc3NhcmlseSBxdW90ZWQgZmllbGQgbmFtZXMgaW4gZ2VuZXJhdGVkIHdoZXJlIGNsYXVzZVxuICAvLyBzbyB0aGF0IGl0IG1hdGNoZXMgdGhlIHdoZXJlX2NsYXVzZSBmcm9tIGRhdGFiYXNlIHNjaGVtYVxuICBjb25zdCBxdW90ZWRGaWVsZE5hbWVzID0gd2hlcmVDbGF1c2UubWF0Y2goL1wiKC4qPylcIi9nKTtcbiAgcXVvdGVkRmllbGROYW1lcy5mb3JFYWNoKChmaWVsZE5hbWUpID0+IHtcbiAgICBjb25zdCB1bnF1b3RlZEZpZWxkTmFtZSA9IGZpZWxkTmFtZS5yZXBsYWNlKC9cIi9nLCAnJyk7XG4gICAgY29uc3QgcmVzZXJ2ZWRLZXl3b3JkcyA9IFtcbiAgICAgICdBREQnLCAnQUdHUkVHQVRFJywgJ0FMTE9XJywgJ0FMVEVSJywgJ0FORCcsICdBTlknLCAnQVBQTFknLFxuICAgICAgJ0FTQycsICdBVVRIT1JJWkUnLCAnQkFUQ0gnLCAnQkVHSU4nLCAnQlknLCAnQ09MVU1ORkFNSUxZJyxcbiAgICAgICdDUkVBVEUnLCAnREVMRVRFJywgJ0RFU0MnLCAnRFJPUCcsICdFQUNIX1FVT1JVTScsICdFTlRSSUVTJyxcbiAgICAgICdGUk9NJywgJ0ZVTEwnLCAnR1JBTlQnLCAnSUYnLCAnSU4nLCAnSU5ERVgnLCAnSU5FVCcsICdJTkZJTklUWScsXG4gICAgICAnSU5TRVJUJywgJ0lOVE8nLCAnS0VZU1BBQ0UnLCAnS0VZU1BBQ0VTJywgJ0xJTUlUJywgJ0xPQ0FMX09ORScsXG4gICAgICAnTE9DQUxfUVVPUlVNJywgJ01BVEVSSUFMSVpFRCcsICdNT0RJRlknLCAnTkFOJywgJ05PUkVDVVJTSVZFJyxcbiAgICAgICdOT1QnLCAnT0YnLCAnT04nLCAnT05FJywgJ09SREVSJywgJ1BBUlRJVElPTicsICdQQVNTV09SRCcsICdQRVInLFxuICAgICAgJ1BSSU1BUlknLCAnUVVPUlVNJywgJ1JFTkFNRScsICdSRVZPS0UnLCAnU0NIRU1BJywgJ1NFTEVDVCcsICdTRVQnLFxuICAgICAgJ1RBQkxFJywgJ1RJTUUnLCAnVEhSRUUnLCAnVE8nLCAnVE9LRU4nLCAnVFJVTkNBVEUnLCAnVFdPJywgJ1VOTE9HR0VEJyxcbiAgICAgICdVUERBVEUnLCAnVVNFJywgJ1VTSU5HJywgJ1ZJRVcnLCAnV0hFUkUnLCAnV0lUSCddO1xuICAgIGlmICh1bnF1b3RlZEZpZWxkTmFtZSA9PT0gdW5xdW90ZWRGaWVsZE5hbWUudG9Mb3dlckNhc2UoKVxuICAgICAgJiYgIXJlc2VydmVkS2V5d29yZHMuaW5jbHVkZXModW5xdW90ZWRGaWVsZE5hbWUudG9VcHBlckNhc2UoKSkpIHtcbiAgICAgIHdoZXJlQ2xhdXNlID0gd2hlcmVDbGF1c2UucmVwbGFjZShmaWVsZE5hbWUsIHVucXVvdGVkRmllbGROYW1lKTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gd2hlcmVDbGF1c2U7XG59O1xuXG5wYXJzZXIuZ2V0X29yZGVyYnlfY2xhdXNlID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCkge1xuICBjb25zdCBvcmRlcktleXMgPSBbXTtcbiAgT2JqZWN0LmtleXMocXVlcnlPYmplY3QpLmZvckVhY2goKGspID0+IHtcbiAgICBjb25zdCBxdWVyeUl0ZW0gPSBxdWVyeU9iamVjdFtrXTtcbiAgICBpZiAoay50b0xvd2VyQ2FzZSgpID09PSAnJG9yZGVyYnknKSB7XG4gICAgICBpZiAoIShxdWVyeUl0ZW0gaW5zdGFuY2VvZiBPYmplY3QpKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRvcmRlcicpKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG9yZGVySXRlbUtleXMgPSBPYmplY3Qua2V5cyhxdWVyeUl0ZW0pO1xuXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG9yZGVySXRlbUtleXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY29uc3QgY3FsT3JkZXJEaXJlY3Rpb24gPSB7ICRhc2M6ICdBU0MnLCAkZGVzYzogJ0RFU0MnIH07XG4gICAgICAgIGlmIChvcmRlckl0ZW1LZXlzW2ldLnRvTG93ZXJDYXNlKCkgaW4gY3FsT3JkZXJEaXJlY3Rpb24pIHtcbiAgICAgICAgICBsZXQgb3JkZXJGaWVsZHMgPSBxdWVyeUl0ZW1bb3JkZXJJdGVtS2V5c1tpXV07XG5cbiAgICAgICAgICBpZiAoIV8uaXNBcnJheShvcmRlckZpZWxkcykpIHtcbiAgICAgICAgICAgIG9yZGVyRmllbGRzID0gW29yZGVyRmllbGRzXTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBmb3IgKGxldCBqID0gMDsgaiA8IG9yZGVyRmllbGRzLmxlbmd0aDsgaisrKSB7XG4gICAgICAgICAgICBvcmRlcktleXMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZShcbiAgICAgICAgICAgICAgJ1wiJXNcIiAlcycsXG4gICAgICAgICAgICAgIG9yZGVyRmllbGRzW2pdLCBjcWxPcmRlckRpcmVjdGlvbltvcmRlckl0ZW1LZXlzW2ldXSxcbiAgICAgICAgICAgICkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkb3JkZXJ0eXBlJywgb3JkZXJJdGVtS2V5c1tpXSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIG9yZGVyS2V5cy5sZW5ndGggPyB1dGlsLmZvcm1hdCgnT1JERVIgQlkgJXMnLCBvcmRlcktleXMuam9pbignLCAnKSkgOiAnICc7XG59O1xuXG5wYXJzZXIuZ2V0X2dyb3VwYnlfY2xhdXNlID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCkge1xuICBsZXQgZ3JvdXBieUtleXMgPSBbXTtcblxuICBPYmplY3Qua2V5cyhxdWVyeU9iamVjdCkuZm9yRWFjaCgoaykgPT4ge1xuICAgIGNvbnN0IHF1ZXJ5SXRlbSA9IHF1ZXJ5T2JqZWN0W2tdO1xuXG4gICAgaWYgKGsudG9Mb3dlckNhc2UoKSA9PT0gJyRncm91cGJ5Jykge1xuICAgICAgaWYgKCEocXVlcnlJdGVtIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRncm91cCcpKTtcbiAgICAgIH1cblxuICAgICAgZ3JvdXBieUtleXMgPSBncm91cGJ5S2V5cy5jb25jYXQocXVlcnlJdGVtKTtcbiAgICB9XG4gIH0pO1xuXG4gIGdyb3VwYnlLZXlzID0gZ3JvdXBieUtleXMubWFwKChrZXkpID0+IGBcIiR7a2V5fVwiYCk7XG5cbiAgcmV0dXJuIGdyb3VwYnlLZXlzLmxlbmd0aCA/IHV0aWwuZm9ybWF0KCdHUk9VUCBCWSAlcycsIGdyb3VwYnlLZXlzLmpvaW4oJywgJykpIDogJyAnO1xufTtcblxucGFyc2VyLmdldF9saW1pdF9jbGF1c2UgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0KSB7XG4gIGxldCBsaW1pdCA9IG51bGw7XG4gIE9iamVjdC5rZXlzKHF1ZXJ5T2JqZWN0KS5mb3JFYWNoKChrKSA9PiB7XG4gICAgY29uc3QgcXVlcnlJdGVtID0gcXVlcnlPYmplY3Rba107XG4gICAgaWYgKGsudG9Mb3dlckNhc2UoKSA9PT0gJyRsaW1pdCcpIHtcbiAgICAgIGlmICh0eXBlb2YgcXVlcnlJdGVtICE9PSAnbnVtYmVyJykgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQubGltaXR0eXBlJykpO1xuICAgICAgbGltaXQgPSBxdWVyeUl0ZW07XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIGxpbWl0ID8gdXRpbC5mb3JtYXQoJ0xJTUlUICVzJywgbGltaXQpIDogJyAnO1xufTtcblxucGFyc2VyLmdldF9zZWxlY3RfY2xhdXNlID0gZnVuY3Rpb24gZihvcHRpb25zKSB7XG4gIGxldCBzZWxlY3RDbGF1c2UgPSAnKic7XG4gIGlmIChvcHRpb25zLnNlbGVjdCAmJiBfLmlzQXJyYXkob3B0aW9ucy5zZWxlY3QpICYmIG9wdGlvbnMuc2VsZWN0Lmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBzZWxlY3RBcnJheSA9IFtdO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgb3B0aW9ucy5zZWxlY3QubGVuZ3RoOyBpKyspIHtcbiAgICAgIC8vIHNlcGFyYXRlIHRoZSBhZ2dyZWdhdGUgZnVuY3Rpb24gYW5kIHRoZSBjb2x1bW4gbmFtZSBpZiBzZWxlY3QgaXMgYW4gYWdncmVnYXRlIGZ1bmN0aW9uXG4gICAgICBjb25zdCBzZWxlY3Rpb24gPSBvcHRpb25zLnNlbGVjdFtpXS5zcGxpdCgvWygsICldL2cpLmZpbHRlcigoZSkgPT4gKGUpKTtcbiAgICAgIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAxKSB7XG4gICAgICAgIGlmIChzZWxlY3Rpb25bMF0gPT09ICcqJykgc2VsZWN0QXJyYXkucHVzaCgnKicpO1xuICAgICAgICBlbHNlIHNlbGVjdEFycmF5LnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHNlbGVjdGlvblswXSkpO1xuICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAyKSB7XG4gICAgICAgIHNlbGVjdEFycmF5LnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJyVzKFwiJXNcIiknLCBzZWxlY3Rpb25bMF0sIHNlbGVjdGlvblsxXSkpO1xuICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID49IDMgJiYgc2VsZWN0aW9uW3NlbGVjdGlvbi5sZW5ndGggLSAyXS50b0xvd2VyQ2FzZSgpID09PSAnYXMnKSB7XG4gICAgICAgIGNvbnN0IHNlbGVjdGlvbkVuZENodW5rID0gc2VsZWN0aW9uLnNwbGljZShzZWxlY3Rpb24ubGVuZ3RoIC0gMik7XG4gICAgICAgIGxldCBzZWxlY3Rpb25DaHVuayA9ICcnO1xuICAgICAgICBpZiAoc2VsZWN0aW9uLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgIHNlbGVjdGlvbkNodW5rID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHNlbGVjdGlvblswXSk7XG4gICAgICAgIH0gZWxzZSBpZiAoc2VsZWN0aW9uLmxlbmd0aCA9PT0gMikge1xuICAgICAgICAgIHNlbGVjdGlvbkNodW5rID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJyVzKFwiJXNcIiknLCBzZWxlY3Rpb25bMF0sIHNlbGVjdGlvblsxXSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc2VsZWN0aW9uQ2h1bmsgPSB1dGlsLmZvcm1hdCgnJXMoJXMpJywgc2VsZWN0aW9uWzBdLCBgXCIke3NlbGVjdGlvbi5zcGxpY2UoMSkuam9pbignXCIsXCInKX1cImApO1xuICAgICAgICB9XG4gICAgICAgIHNlbGVjdEFycmF5LnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJyVzIEFTIFwiJXNcIicsIHNlbGVjdGlvbkNodW5rLCBzZWxlY3Rpb25FbmRDaHVua1sxXSkpO1xuICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID49IDMpIHtcbiAgICAgICAgc2VsZWN0QXJyYXkucHVzaCh1dGlsLmZvcm1hdCgnJXMoJXMpJywgc2VsZWN0aW9uWzBdLCBgXCIke3NlbGVjdGlvbi5zcGxpY2UoMSkuam9pbignXCIsXCInKX1cImApKTtcbiAgICAgIH1cbiAgICB9XG4gICAgc2VsZWN0Q2xhdXNlID0gc2VsZWN0QXJyYXkuam9pbignLCcpO1xuICB9XG4gIHJldHVybiBzZWxlY3RDbGF1c2U7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IHBhcnNlcjtcbiJdfQ==