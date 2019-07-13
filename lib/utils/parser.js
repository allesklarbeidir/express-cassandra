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
  } while (m);

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9wYXJzZXIuanMiXSwibmFtZXMiOlsiUHJvbWlzZSIsInJlcXVpcmUiLCJfIiwidXRpbCIsImRzZURyaXZlciIsImUiLCJjcWwiLCJwcm9taXNpZnlBbGwiLCJidWlsZEVycm9yIiwiZGF0YXR5cGVzIiwic2NoZW1lciIsInBhcnNlciIsImZvcm1hdEpTT05CQ29sdW1uQXdhcmUiLCJmb3JtYXRTdHJpbmciLCJwbGFjZWhvbGRlcnMiLCJyZSIsIm1hdGNoIiwiZXhlYyIsInB1c2giLCJtIiwicGFyYW1zIiwiZm9yRWFjaCIsInAiLCJpIiwibGVuZ3RoIiwiaW5kZXhPZiIsImZwIiwiaW5kZXgiLCJmb3JtYXQiLCJjYWxsYmFja19vcl90aHJvdyIsImYiLCJlcnIiLCJjYWxsYmFjayIsImV4dHJhY3RfdHlwZSIsInZhbCIsImRlY29tcG9zZWQiLCJyZXBsYWNlIiwic3BsaXQiLCJkIiwiaGFzIiwiZXh0cmFjdF90eXBlRGVmIiwic3Vic3RyIiwiZXh0cmFjdF9hbHRlcmVkX3R5cGUiLCJub3JtYWxpemVkTW9kZWxTY2hlbWEiLCJkaWZmIiwiZmllbGROYW1lIiwicGF0aCIsInR5cGUiLCJyaHMiLCJmaWVsZHMiLCJ0eXBlRGVmIiwiZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24iLCJzY2hlbWEiLCJmaWVsZFZhbHVlIiwidHlwZXMiLCJ1bnNldCIsInF1ZXJ5X3NlZ21lbnQiLCJwYXJhbWV0ZXIiLCJpc1BsYWluT2JqZWN0IiwiJGRiX2Z1bmN0aW9uIiwiZmllbGRUeXBlIiwiZ2V0X2ZpZWxkX3R5cGUiLCJ2YWxpZGF0b3JzIiwiZ2V0X3ZhbGlkYXRvcnMiLCJpc0FycmF5IiwibWFwIiwidiIsImRiVmFsIiwidmFsaWRhdGlvbk1lc3NhZ2UiLCJnZXRfdmFsaWRhdGlvbl9tZXNzYWdlIiwiY291bnRlclF1ZXJ5U2VnbWVudCIsIk1hdGgiLCJhYnMiLCJ1bnNldF9ub3RfYWxsb3dlZCIsIm9wZXJhdGlvbiIsImlzX3ByaW1hcnlfa2V5X2ZpZWxkIiwiaXNfcmVxdWlyZWRfZmllbGQiLCJnZXRfaW5wbGFjZV91cGRhdGVfZXhwcmVzc2lvbiIsInVwZGF0ZUNsYXVzZXMiLCJxdWVyeVBhcmFtcyIsIiRhZGQiLCIkYXBwZW5kIiwiJHByZXBlbmQiLCIkcmVwbGFjZSIsIiRyZW1vdmUiLCJpbmNsdWRlcyIsIk9iamVjdCIsImtleXMiLCJyZXBsYWNlS2V5cyIsInJlcGxhY2VWYWx1ZXMiLCJ2YWx1ZXMiLCJnZXRfdXBkYXRlX3ZhbHVlX2V4cHJlc3Npb24iLCJpbnN0YW5jZSIsInVwZGF0ZVZhbHVlcyIsIm9wdGlvbnMiLCJ0aW1lc3RhbXBzIiwidXBkYXRlZEF0IiwidmVyc2lvbnMiLCJrZXkiLCJlcnJvckhhcHBlbmVkIiwic29tZSIsInVuZGVmaW5lZCIsInZpcnR1YWwiLCJfZ2V0X2RlZmF1bHRfdmFsdWUiLCJydWxlIiwiaWdub3JlX2RlZmF1bHQiLCJ2YWxpZGF0ZSIsImdldF9zYXZlX3ZhbHVlX2V4cHJlc3Npb24iLCJmbiIsImlkZW50aWZpZXJzIiwiZXh0cmFjdF9xdWVyeV9yZWxhdGlvbnMiLCJyZWxhdGlvbktleSIsInJlbGF0aW9uVmFsdWUiLCJ2YWxpZE9wZXJhdG9ycyIsInF1ZXJ5UmVsYXRpb25zIiwidG9Mb3dlckNhc2UiLCJvcGVyYXRvciIsIndoZXJlVGVtcGxhdGUiLCJidWlsZFF1ZXJ5UmVsYXRpb25zIiwiZmllbGROYW1lTG9jYWwiLCJyZWxhdGlvblZhbHVlTG9jYWwiLCJidWlsZFRva2VuUXVlcnlSZWxhdGlvbnMiLCJ0b2tlblJlbGF0aW9uS2V5IiwidG9rZW5SZWxhdGlvblZhbHVlIiwidG9rZW5LZXlzIiwidG9rZW5JbmRleCIsInRyaW0iLCJqb2luIiwidG9TdHJpbmciLCJ0b2tlblJlbGF0aW9uS2V5cyIsInRva2VuUksiLCJmaWVsZFR5cGUxIiwiZmllbGRUeXBlMiIsIl9wYXJzZV9xdWVyeV9vYmplY3QiLCJxdWVyeU9iamVjdCIsInN0YXJ0c1dpdGgiLCJxdWVyeSIsIndoZXJlT2JqZWN0IiwiZmsiLCJmaWVsZFJlbGF0aW9uIiwiY3FsT3BlcmF0b3JzIiwiJGVxIiwiJG5lIiwiJGlzbnQiLCIkZ3QiLCIkbHQiLCIkZ3RlIiwiJGx0ZSIsIiRpbiIsIiRsaWtlIiwiJHRva2VuIiwiJGNvbnRhaW5zIiwiJGNvbnRhaW5zX2tleSIsInZhbGlkS2V5cyIsImZpZWxkUmVsYXRpb25LZXlzIiwicmVsYXRpb25LZXlzIiwicmsiLCJleHRyYWN0ZWRSZWxhdGlvbnMiLCJjb25jYXQiLCJnZXRfZmlsdGVyX2NsYXVzZSIsImNsYXVzZSIsInBhcnNlZE9iamVjdCIsImZpbHRlckNsYXVzZSIsImdldF9maWx0ZXJfY2xhdXNlX2RkbCIsImZpbHRlclF1ZXJ5IiwicGFyYW0iLCJxdWVyeVBhcmFtIiwiRGF0ZSIsInRvSVNPU3RyaW5nIiwiTG9uZyIsIkludGVnZXIiLCJCaWdEZWNpbWFsIiwiVGltZVV1aWQiLCJVdWlkIiwiTG9jYWxEYXRlIiwiTG9jYWxUaW1lIiwiSW5ldEFkZHJlc3MiLCJnZXRfd2hlcmVfY2xhdXNlIiwiZ2V0X2lmX2NsYXVzZSIsImdldF9wcmltYXJ5X2tleV9jbGF1c2VzIiwicGFydGl0aW9uS2V5IiwiY2x1c3RlcmluZ0tleSIsInNsaWNlIiwiY2x1c3RlcmluZ09yZGVyIiwiZmllbGQiLCJjbHVzdGVyaW5nX29yZGVyIiwiY2x1c3RlcmluZ09yZGVyQ2xhdXNlIiwicGFydGl0aW9uS2V5Q2xhdXNlIiwiY2x1c3RlcmluZ0tleUNsYXVzZSIsImdldF9tdmlld193aGVyZV9jbGF1c2UiLCJ2aWV3U2NoZW1hIiwiY2xhdXNlcyIsIndoZXJlQ2xhdXNlIiwiZmlsdGVycyIsImNsb25lRGVlcCIsImZpbHRlcktleSIsInF1b3RlZEZpZWxkTmFtZXMiLCJ1bnF1b3RlZEZpZWxkTmFtZSIsInJlc2VydmVkS2V5d29yZHMiLCJ0b1VwcGVyQ2FzZSIsImdldF9vcmRlcmJ5X2NsYXVzZSIsIm9yZGVyS2V5cyIsImsiLCJxdWVyeUl0ZW0iLCJvcmRlckl0ZW1LZXlzIiwiY3FsT3JkZXJEaXJlY3Rpb24iLCIkYXNjIiwiJGRlc2MiLCJvcmRlckZpZWxkcyIsImoiLCJnZXRfZ3JvdXBieV9jbGF1c2UiLCJncm91cGJ5S2V5cyIsIkFycmF5IiwiZ2V0X2xpbWl0X2NsYXVzZSIsImxpbWl0IiwiZ2V0X3NlbGVjdF9jbGF1c2UiLCJzZWxlY3RDbGF1c2UiLCJzZWxlY3QiLCJzZWxlY3RBcnJheSIsInNlbGVjdGlvbiIsImZpbHRlciIsInNlbGVjdGlvbkVuZENodW5rIiwic3BsaWNlIiwic2VsZWN0aW9uQ2h1bmsiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOztBQUFBLElBQU1BLFVBQVVDLFFBQVEsVUFBUixDQUFoQjtBQUNBLElBQU1DLElBQUlELFFBQVEsUUFBUixDQUFWO0FBQ0EsSUFBTUUsT0FBT0YsUUFBUSxNQUFSLENBQWI7O0FBRUEsSUFBSUcsa0JBQUo7QUFDQSxJQUFJO0FBQ0Y7QUFDQUEsY0FBWUgsUUFBUSxZQUFSLENBQVo7QUFDRCxDQUhELENBR0UsT0FBT0ksQ0FBUCxFQUFVO0FBQ1ZELGNBQVksSUFBWjtBQUNEOztBQUVELElBQU1FLE1BQU1OLFFBQVFPLFlBQVIsQ0FBcUJILGFBQWFILFFBQVEsa0JBQVIsQ0FBbEMsQ0FBWjs7QUFFQSxJQUFNTyxhQUFhUCxRQUFRLHdCQUFSLENBQW5CO0FBQ0EsSUFBTVEsWUFBWVIsUUFBUSx5QkFBUixDQUFsQjtBQUNBLElBQU1TLFVBQVVULFFBQVEsc0JBQVIsQ0FBaEI7O0FBRUEsSUFBTVUsU0FBUyxFQUFmOztBQUVBQSxPQUFPQyxzQkFBUCxHQUFnQyxVQUFTQyxZQUFULEVBQWlDOztBQUUvRCxNQUFNQyxlQUFlLEVBQXJCOztBQUVBLE1BQU1DLEtBQUssS0FBWDtBQUNBLE1BQUlDLGNBQUo7QUFDQSxLQUFHO0FBQ0NBLFlBQVFELEdBQUdFLElBQUgsQ0FBUUosWUFBUixDQUFSO0FBQ0EsUUFBSUcsS0FBSixFQUFXO0FBQ1BGLG1CQUFhSSxJQUFiLENBQWtCRixLQUFsQjtBQUNIO0FBQ0osR0FMRCxRQUtTRyxDQUxUOztBQU4rRCxv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LFVBQVUsQ0FBVixDQUF0QixFQUFxQyxJQUFHQSxVQUFVRyxNQUFWLENBQWlCLENBQWpCLEVBQW9CL0YsSUFBcEIsQ0FBeUIsS0FBekIsQ0FBZ0MsR0FBeEUsQ0FBakI7QUFDRDtBQUNGO0FBQ0R5RixtQkFBZUUsWUFBWTNGLElBQVosQ0FBaUIsR0FBakIsQ0FBZjtBQUNEO0FBQ0QsU0FBT3lGLFlBQVA7QUFDRCxDQTlCRDs7QUFnQ0FRLE9BQU9DLE9BQVAsR0FBaUJ0TixNQUFqQiIsImZpbGUiOiJwYXJzZXIuanMiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCBQcm9taXNlID0gcmVxdWlyZSgnYmx1ZWJpcmQnKTtcbmNvbnN0IF8gPSByZXF1aXJlKCdsb2Rhc2gnKTtcbmNvbnN0IHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5cbmxldCBkc2VEcml2ZXI7XG50cnkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgaW1wb3J0L25vLWV4dHJhbmVvdXMtZGVwZW5kZW5jaWVzLCBpbXBvcnQvbm8tdW5yZXNvbHZlZFxuICBkc2VEcml2ZXIgPSByZXF1aXJlKCdkc2UtZHJpdmVyJyk7XG59IGNhdGNoIChlKSB7XG4gIGRzZURyaXZlciA9IG51bGw7XG59XG5cbmNvbnN0IGNxbCA9IFByb21pc2UucHJvbWlzaWZ5QWxsKGRzZURyaXZlciB8fCByZXF1aXJlKCdjYXNzYW5kcmEtZHJpdmVyJykpO1xuXG5jb25zdCBidWlsZEVycm9yID0gcmVxdWlyZSgnLi4vb3JtL2Fwb2xsb19lcnJvci5qcycpO1xuY29uc3QgZGF0YXR5cGVzID0gcmVxdWlyZSgnLi4vdmFsaWRhdG9ycy9kYXRhdHlwZXMnKTtcbmNvbnN0IHNjaGVtZXIgPSByZXF1aXJlKCcuLi92YWxpZGF0b3JzL3NjaGVtYScpO1xuXG5jb25zdCBwYXJzZXIgPSB7fTtcblxucGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUgPSBmdW5jdGlvbihmb3JtYXRTdHJpbmcsIC4uLnBhcmFtcyl7XG5cbiAgY29uc3QgcGxhY2Vob2xkZXJzID0gW107XG5cbiAgY29uc3QgcmUgPSAvJS4vZztcbiAgbGV0IG1hdGNoO1xuICBkbyB7XG4gICAgICBtYXRjaCA9IHJlLmV4ZWMoZm9ybWF0U3RyaW5nKTtcbiAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICAgIHBsYWNlaG9sZGVycy5wdXNoKG1hdGNoKVxuICAgICAgfVxuICB9IHdoaWxlIChtKTtcblxuICAocGFyYW1zIHx8IFtdKS5mb3JFYWNoKChwLGkpID0+IHtcbiAgICBpZihpIDwgcGxhY2Vob2xkZXJzLmxlbmd0aCAmJiB0eXBlb2YocCkgPT09IFwic3RyaW5nXCIgJiYgcC5pbmRleE9mKFwiLT5cIikgIT09IC0xKXtcbiAgICAgIGNvbnN0IGZwID0gcGxhY2Vob2xkZXJzW2ldO1xuICAgICAgaWYoXG4gICAgICAgIGZwLmluZGV4ID4gMCAmJlxuICAgICAgICBmb3JtYXRTdHJpbmcubGVuZ3RoID4gZnAuaW5kZXgrMiAmJlxuICAgICAgICBmb3JtYXRTdHJpbmdbZnAuaW5kZXgtMV0gPT09ICdcIicgJiZcbiAgICAgICAgZm9ybWF0U3RyaW5nW2ZwLmluZGV4KzJdID09PSAnXCInXG4gICAgICApe1xuICAgICAgICBmb3JtYXRTdHJpbmdbZnAuaW5kZXgtMV0gPSBcIiBcIjtcbiAgICAgICAgZm9ybWF0U3RyaW5nW2ZwLmluZGV4KzJdID0gXCIgXCI7XG4gICAgICB9XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4gdXRpbC5mb3JtYXQoZm9ybWF0U3RyaW5nLCAuLi5wYXJhbXMpO1xufVxuXG5wYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3cgPSBmdW5jdGlvbiBmKGVyciwgY2FsbGJhY2spIHtcbiAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrKGVycik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRocm93IChlcnIpO1xufTtcblxucGFyc2VyLmV4dHJhY3RfdHlwZSA9IGZ1bmN0aW9uIGYodmFsKSB7XG4gIC8vIGRlY29tcG9zZSBjb21wb3NpdGUgdHlwZXNcbiAgY29uc3QgZGVjb21wb3NlZCA9IHZhbCA/IHZhbC5yZXBsYWNlKC9bXFxzXS9nLCAnJykuc3BsaXQoL1s8LD5dL2cpIDogWycnXTtcblxuICBmb3IgKGxldCBkID0gMDsgZCA8IGRlY29tcG9zZWQubGVuZ3RoOyBkKyspIHtcbiAgICBpZiAoXy5oYXMoZGF0YXR5cGVzLCBkZWNvbXBvc2VkW2RdKSkge1xuICAgICAgcmV0dXJuIGRlY29tcG9zZWRbZF07XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHZhbDtcbn07XG5cbnBhcnNlci5leHRyYWN0X3R5cGVEZWYgPSBmdW5jdGlvbiBmKHZhbCkge1xuICAvLyBkZWNvbXBvc2UgY29tcG9zaXRlIHR5cGVzXG4gIGxldCBkZWNvbXBvc2VkID0gdmFsID8gdmFsLnJlcGxhY2UoL1tcXHNdL2csICcnKSA6ICcnO1xuICBkZWNvbXBvc2VkID0gZGVjb21wb3NlZC5zdWJzdHIoZGVjb21wb3NlZC5pbmRleE9mKCc8JyksIGRlY29tcG9zZWQubGVuZ3RoIC0gZGVjb21wb3NlZC5pbmRleE9mKCc8JykpO1xuXG4gIHJldHVybiBkZWNvbXBvc2VkO1xufTtcblxucGFyc2VyLmV4dHJhY3RfYWx0ZXJlZF90eXBlID0gZnVuY3Rpb24gZihub3JtYWxpemVkTW9kZWxTY2hlbWEsIGRpZmYpIHtcbiAgY29uc3QgZmllbGROYW1lID0gZGlmZi5wYXRoWzBdO1xuICBsZXQgdHlwZSA9ICcnO1xuICBpZiAoZGlmZi5wYXRoLmxlbmd0aCA+IDEpIHtcbiAgICBpZiAoZGlmZi5wYXRoWzFdID09PSAndHlwZScpIHtcbiAgICAgIHR5cGUgPSBkaWZmLnJocztcbiAgICAgIGlmIChub3JtYWxpemVkTW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZURlZikge1xuICAgICAgICB0eXBlICs9IG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlRGVmO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0eXBlID0gbm9ybWFsaXplZE1vZGVsU2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGU7XG4gICAgICB0eXBlICs9IGRpZmYucmhzO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB0eXBlID0gZGlmZi5yaHMudHlwZTtcbiAgICBpZiAoZGlmZi5yaHMudHlwZURlZikgdHlwZSArPSBkaWZmLnJocy50eXBlRGVmO1xuICB9XG4gIHJldHVybiB0eXBlO1xufTtcblxucGFyc2VyLmdldF9kYl92YWx1ZV9leHByZXNzaW9uID0gZnVuY3Rpb24gZihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSkge1xuICBpZiAoZmllbGRWYWx1ZSA9PSBudWxsIHx8IGZpZWxkVmFsdWUgPT09IGNxbC50eXBlcy51bnNldCkge1xuICAgIHJldHVybiB7IHF1ZXJ5X3NlZ21lbnQ6ICc/JywgcGFyYW1ldGVyOiBmaWVsZFZhbHVlIH07XG4gIH1cblxuICBpZiAoXy5pc1BsYWluT2JqZWN0KGZpZWxkVmFsdWUpICYmIGZpZWxkVmFsdWUuJGRiX2Z1bmN0aW9uKSB7XG4gICAgcmV0dXJuIGZpZWxkVmFsdWUuJGRiX2Z1bmN0aW9uO1xuICB9XG5cbiAgY29uc3QgZmllbGRUeXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG4gIGNvbnN0IHZhbGlkYXRvcnMgPSBzY2hlbWVyLmdldF92YWxpZGF0b3JzKHNjaGVtYSwgZmllbGROYW1lKTtcblxuICBpZiAoXy5pc0FycmF5KGZpZWxkVmFsdWUpICYmIGZpZWxkVHlwZSAhPT0gJ2xpc3QnICYmIGZpZWxkVHlwZSAhPT0gJ3NldCcgJiYgZmllbGRUeXBlICE9PSAnZnJvemVuJykge1xuICAgIGNvbnN0IHZhbCA9IGZpZWxkVmFsdWUubWFwKCh2KSA9PiB7XG4gICAgICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZSwgdik7XG5cbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHJldHVybiBkYlZhbC5wYXJhbWV0ZXI7XG4gICAgICByZXR1cm4gZGJWYWw7XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBxdWVyeV9zZWdtZW50OiAnPycsIHBhcmFtZXRlcjogdmFsIH07XG4gIH1cblxuICBjb25zdCB2YWxpZGF0aW9uTWVzc2FnZSA9IHNjaGVtZXIuZ2V0X3ZhbGlkYXRpb25fbWVzc2FnZSh2YWxpZGF0b3JzLCBmaWVsZFZhbHVlKTtcbiAgaWYgKHR5cGVvZiB2YWxpZGF0aW9uTWVzc2FnZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHZhbHVlJywgdmFsaWRhdGlvbk1lc3NhZ2UoZmllbGRWYWx1ZSwgZmllbGROYW1lLCBmaWVsZFR5cGUpKSk7XG4gIH1cblxuICBpZiAoZmllbGRUeXBlID09PSAnY291bnRlcicpIHtcbiAgICBsZXQgY291bnRlclF1ZXJ5U2VnbWVudCA9IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCInLCBmaWVsZE5hbWUpO1xuICAgIGlmIChmaWVsZFZhbHVlID49IDApIGNvdW50ZXJRdWVyeVNlZ21lbnQgKz0gJyArID8nO1xuICAgIGVsc2UgY291bnRlclF1ZXJ5U2VnbWVudCArPSAnIC0gPyc7XG4gICAgZmllbGRWYWx1ZSA9IE1hdGguYWJzKGZpZWxkVmFsdWUpO1xuICAgIHJldHVybiB7IHF1ZXJ5X3NlZ21lbnQ6IGNvdW50ZXJRdWVyeVNlZ21lbnQsIHBhcmFtZXRlcjogZmllbGRWYWx1ZSB9O1xuICB9XG5cbiAgcmV0dXJuIHsgcXVlcnlfc2VnbWVudDogJz8nLCBwYXJhbWV0ZXI6IGZpZWxkVmFsdWUgfTtcbn07XG5cbnBhcnNlci51bnNldF9ub3RfYWxsb3dlZCA9IGZ1bmN0aW9uIGYob3BlcmF0aW9uLCBzY2hlbWEsIGZpZWxkTmFtZSwgY2FsbGJhY2spIHtcbiAgaWYgKHNjaGVtZXIuaXNfcHJpbWFyeV9rZXlfZmllbGQoc2NoZW1hLCBmaWVsZE5hbWUpKSB7XG4gICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGJ1aWxkRXJyb3IoYG1vZGVsLiR7b3BlcmF0aW9ufS51bnNldGtleWAsIGZpZWxkTmFtZSksIGNhbGxiYWNrKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAoc2NoZW1lci5pc19yZXF1aXJlZF9maWVsZChzY2hlbWEsIGZpZWxkTmFtZSkpIHtcbiAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coYnVpbGRFcnJvcihgbW9kZWwuJHtvcGVyYXRpb259LnVuc2V0cmVxdWlyZWRgLCBmaWVsZE5hbWUpLCBjYWxsYmFjayk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufTtcblxucGFyc2VyLmdldF9pbnBsYWNlX3VwZGF0ZV9leHByZXNzaW9uID0gZnVuY3Rpb24gZihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSwgdXBkYXRlQ2xhdXNlcywgcXVlcnlQYXJhbXMpIHtcbiAgY29uc3QgJGFkZCA9IChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kYWRkKSB8fCBmYWxzZTtcbiAgY29uc3QgJGFwcGVuZCA9IChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kYXBwZW5kKSB8fCBmYWxzZTtcbiAgY29uc3QgJHByZXBlbmQgPSAoXy5pc1BsYWluT2JqZWN0KGZpZWxkVmFsdWUpICYmIGZpZWxkVmFsdWUuJHByZXBlbmQpIHx8IGZhbHNlO1xuICBjb25zdCAkcmVwbGFjZSA9IChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kcmVwbGFjZSkgfHwgZmFsc2U7XG4gIGNvbnN0ICRyZW1vdmUgPSAoXy5pc1BsYWluT2JqZWN0KGZpZWxkVmFsdWUpICYmIGZpZWxkVmFsdWUuJHJlbW92ZSkgfHwgZmFsc2U7XG5cbiAgZmllbGRWYWx1ZSA9ICRhZGQgfHwgJGFwcGVuZCB8fCAkcHJlcGVuZCB8fCAkcmVwbGFjZSB8fCAkcmVtb3ZlIHx8IGZpZWxkVmFsdWU7XG5cbiAgY29uc3QgZGJWYWwgPSBwYXJzZXIuZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24oc2NoZW1hLCBmaWVsZE5hbWUsIGZpZWxkVmFsdWUpO1xuXG4gIGlmICghXy5pc1BsYWluT2JqZWN0KGRiVmFsKSB8fCAhZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgIHVwZGF0ZUNsYXVzZXMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiPSVzJywgZmllbGROYW1lLCBkYlZhbCkpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGZpZWxkVHlwZSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBmaWVsZE5hbWUpO1xuXG4gIGlmIChbJ21hcCcsICdsaXN0JywgJ3NldCddLmluY2x1ZGVzKGZpZWxkVHlwZSkpIHtcbiAgICBpZiAoJGFkZCB8fCAkYXBwZW5kKSB7XG4gICAgICBkYlZhbC5xdWVyeV9zZWdtZW50ID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIiArICVzJywgZmllbGROYW1lLCBkYlZhbC5xdWVyeV9zZWdtZW50KTtcbiAgICB9IGVsc2UgaWYgKCRwcmVwZW5kKSB7XG4gICAgICBpZiAoZmllbGRUeXBlID09PSAnbGlzdCcpIHtcbiAgICAgICAgZGJWYWwucXVlcnlfc2VnbWVudCA9IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCclcyArIFwiJXNcIicsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQsIGZpZWxkTmFtZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcihcbiAgICAgICAgICAnbW9kZWwudXBkYXRlLmludmFsaWRwcmVwZW5kb3AnLFxuICAgICAgICAgIHV0aWwuZm9ybWF0KCclcyBkYXRhdHlwZXMgZG9lcyBub3Qgc3VwcG9ydCAkcHJlcGVuZCwgdXNlICRhZGQgaW5zdGVhZCcsIGZpZWxkVHlwZSksXG4gICAgICAgICkpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoJHJlbW92ZSkge1xuICAgICAgZGJWYWwucXVlcnlfc2VnbWVudCA9IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCIgLSAlcycsIGZpZWxkTmFtZSwgZGJWYWwucXVlcnlfc2VnbWVudCk7XG4gICAgICBpZiAoZmllbGRUeXBlID09PSAnbWFwJykgZGJWYWwucGFyYW1ldGVyID0gT2JqZWN0LmtleXMoZGJWYWwucGFyYW1ldGVyKTtcbiAgICB9XG4gIH1cblxuICBpZiAoJHJlcGxhY2UpIHtcbiAgICBpZiAoZmllbGRUeXBlID09PSAnbWFwJykge1xuICAgICAgdXBkYXRlQ2xhdXNlcy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCJbP109JXMnLCBmaWVsZE5hbWUsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpKTtcbiAgICAgIGNvbnN0IHJlcGxhY2VLZXlzID0gT2JqZWN0LmtleXMoZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgIGNvbnN0IHJlcGxhY2VWYWx1ZXMgPSBfLnZhbHVlcyhkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgaWYgKHJlcGxhY2VLZXlzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKHJlcGxhY2VLZXlzWzBdKTtcbiAgICAgICAgcXVlcnlQYXJhbXMucHVzaChyZXBsYWNlVmFsdWVzWzBdKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IChcbiAgICAgICAgICBidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuaW52YWxpZHJlcGxhY2VvcCcsICckcmVwbGFjZSBpbiBtYXAgZG9lcyBub3Qgc3VwcG9ydCBtb3JlIHRoYW4gb25lIGl0ZW0nKVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoZmllbGRUeXBlID09PSAnbGlzdCcpIHtcbiAgICAgIHVwZGF0ZUNsYXVzZXMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiWz9dPSVzJywgZmllbGROYW1lLCBkYlZhbC5xdWVyeV9zZWdtZW50KSk7XG4gICAgICBpZiAoZGJWYWwucGFyYW1ldGVyLmxlbmd0aCA9PT0gMikge1xuICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlclswXSk7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyWzFdKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKFxuICAgICAgICAgICdtb2RlbC51cGRhdGUuaW52YWxpZHJlcGxhY2VvcCcsXG4gICAgICAgICAgJyRyZXBsYWNlIGluIGxpc3Qgc2hvdWxkIGhhdmUgZXhhY3RseSAyIGl0ZW1zLCBmaXJzdCBvbmUgYXMgdGhlIGluZGV4IGFuZCB0aGUgc2Vjb25kIG9uZSBhcyB0aGUgdmFsdWUnLFxuICAgICAgICApKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoXG4gICAgICAgICdtb2RlbC51cGRhdGUuaW52YWxpZHJlcGxhY2VvcCcsXG4gICAgICAgIHV0aWwuZm9ybWF0KCclcyBkYXRhdHlwZXMgZG9lcyBub3Qgc3VwcG9ydCAkcmVwbGFjZScsIGZpZWxkVHlwZSksXG4gICAgICApKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgdXBkYXRlQ2xhdXNlcy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCI9JXMnLCBmaWVsZE5hbWUsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpKTtcbiAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gIH1cbn07XG5cbnBhcnNlci5nZXRfdXBkYXRlX3ZhbHVlX2V4cHJlc3Npb24gPSBmdW5jdGlvbiBmKGluc3RhbmNlLCBzY2hlbWEsIHVwZGF0ZVZhbHVlcywgY2FsbGJhY2spIHtcbiAgY29uc3QgdXBkYXRlQ2xhdXNlcyA9IFtdO1xuICBjb25zdCBxdWVyeVBhcmFtcyA9IFtdO1xuXG4gIGlmIChzY2hlbWEub3B0aW9ucyAmJiBzY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzKSB7XG4gICAgaWYgKCF1cGRhdGVWYWx1ZXNbc2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy51cGRhdGVkQXRdKSB7XG4gICAgICB1cGRhdGVWYWx1ZXNbc2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy51cGRhdGVkQXRdID0geyAkZGJfZnVuY3Rpb246ICd0b1RpbWVzdGFtcChub3coKSknIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKHNjaGVtYS5vcHRpb25zICYmIHNjaGVtYS5vcHRpb25zLnZlcnNpb25zKSB7XG4gICAgaWYgKCF1cGRhdGVWYWx1ZXNbc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5XSkge1xuICAgICAgdXBkYXRlVmFsdWVzW3NjaGVtYS5vcHRpb25zLnZlcnNpb25zLmtleV0gPSB7ICRkYl9mdW5jdGlvbjogJ25vdygpJyB9O1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGVycm9ySGFwcGVuZWQgPSBPYmplY3Qua2V5cyh1cGRhdGVWYWx1ZXMpLnNvbWUoKGZpZWxkTmFtZSkgPT4ge1xuICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gPT09IHVuZGVmaW5lZCB8fCBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udmlydHVhbCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgY29uc3QgZmllbGRUeXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG4gICAgbGV0IGZpZWxkVmFsdWUgPSB1cGRhdGVWYWx1ZXNbZmllbGROYW1lXTtcblxuICAgIGlmIChmaWVsZFZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGZpZWxkVmFsdWUgPSBpbnN0YW5jZS5fZ2V0X2RlZmF1bHRfdmFsdWUoZmllbGROYW1lKTtcbiAgICAgIGlmIChmaWVsZFZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIHBhcnNlci51bnNldF9ub3RfYWxsb3dlZCgndXBkYXRlJywgc2NoZW1hLCBmaWVsZE5hbWUsIGNhbGxiYWNrKTtcbiAgICAgIH0gZWxzZSBpZiAoIXNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5ydWxlIHx8ICFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0ucnVsZS5pZ25vcmVfZGVmYXVsdCkge1xuICAgICAgICAvLyBkaWQgc2V0IGEgZGVmYXVsdCB2YWx1ZSwgaWdub3JlIGRlZmF1bHQgaXMgbm90IHNldFxuICAgICAgICBpZiAoaW5zdGFuY2UudmFsaWRhdGUoZmllbGROYW1lLCBmaWVsZFZhbHVlKSAhPT0gdHJ1ZSkge1xuICAgICAgICAgIHBhcnNlci5jYWxsYmFja19vcl90aHJvdyhidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuaW52YWxpZGRlZmF1bHR2YWx1ZScsIGZpZWxkVmFsdWUsIGZpZWxkTmFtZSwgZmllbGRUeXBlKSwgY2FsbGJhY2spO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUgPT09IG51bGwgfHwgZmllbGRWYWx1ZSA9PT0gY3FsLnR5cGVzLnVuc2V0KSB7XG4gICAgICBpZiAocGFyc2VyLnVuc2V0X25vdF9hbGxvd2VkKCd1cGRhdGUnLCBzY2hlbWEsIGZpZWxkTmFtZSwgY2FsbGJhY2spKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBwYXJzZXIuZ2V0X2lucGxhY2VfdXBkYXRlX2V4cHJlc3Npb24oc2NoZW1hLCBmaWVsZE5hbWUsIGZpZWxkVmFsdWUsIHVwZGF0ZUNsYXVzZXMsIHF1ZXJ5UGFyYW1zKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coZSwgY2FsbGJhY2spO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSk7XG5cbiAgcmV0dXJuIHsgdXBkYXRlQ2xhdXNlcywgcXVlcnlQYXJhbXMsIGVycm9ySGFwcGVuZWQgfTtcbn07XG5cbnBhcnNlci5nZXRfc2F2ZV92YWx1ZV9leHByZXNzaW9uID0gZnVuY3Rpb24gZm4oaW5zdGFuY2UsIHNjaGVtYSwgY2FsbGJhY2spIHtcbiAgY29uc3QgaWRlbnRpZmllcnMgPSBbXTtcbiAgY29uc3QgdmFsdWVzID0gW107XG4gIGNvbnN0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgaWYgKHNjaGVtYS5vcHRpb25zICYmIHNjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMpIHtcbiAgICBpZiAoaW5zdGFuY2Vbc2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy51cGRhdGVkQXRdKSB7XG4gICAgICBpbnN0YW5jZVtzY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzLnVwZGF0ZWRBdF0gPSB7ICRkYl9mdW5jdGlvbjogJ3RvVGltZXN0YW1wKG5vdygpKScgfTtcbiAgICB9XG4gIH1cblxuICBpZiAoc2NoZW1hLm9wdGlvbnMgJiYgc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMpIHtcbiAgICBpZiAoaW5zdGFuY2Vbc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5XSkge1xuICAgICAgaW5zdGFuY2Vbc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5XSA9IHsgJGRiX2Z1bmN0aW9uOiAnbm93KCknIH07XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZXJyb3JIYXBwZW5lZCA9IE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpLnNvbWUoKGZpZWxkTmFtZSkgPT4ge1xuICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udmlydHVhbCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgLy8gY2hlY2sgZmllbGQgdmFsdWVcbiAgICBjb25zdCBmaWVsZFR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwgZmllbGROYW1lKTtcbiAgICBsZXQgZmllbGRWYWx1ZSA9IGluc3RhbmNlW2ZpZWxkTmFtZV07XG5cbiAgICBpZiAoZmllbGRWYWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBmaWVsZFZhbHVlID0gaW5zdGFuY2UuX2dldF9kZWZhdWx0X3ZhbHVlKGZpZWxkTmFtZSk7XG4gICAgICBpZiAoZmllbGRWYWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJldHVybiBwYXJzZXIudW5zZXRfbm90X2FsbG93ZWQoJ3NhdmUnLCBzY2hlbWEsIGZpZWxkTmFtZSwgY2FsbGJhY2spO1xuICAgICAgfSBlbHNlIGlmICghc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnJ1bGUgfHwgIXNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5ydWxlLmlnbm9yZV9kZWZhdWx0KSB7XG4gICAgICAgIC8vIGRpZCBzZXQgYSBkZWZhdWx0IHZhbHVlLCBpZ25vcmUgZGVmYXVsdCBpcyBub3Qgc2V0XG4gICAgICAgIGlmIChpbnN0YW5jZS52YWxpZGF0ZShmaWVsZE5hbWUsIGZpZWxkVmFsdWUpICE9PSB0cnVlKSB7XG4gICAgICAgICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuaW52YWxpZGRlZmF1bHR2YWx1ZScsIGZpZWxkVmFsdWUsIGZpZWxkTmFtZSwgZmllbGRUeXBlKSwgY2FsbGJhY2spO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUgPT09IG51bGwgfHwgZmllbGRWYWx1ZSA9PT0gY3FsLnR5cGVzLnVuc2V0KSB7XG4gICAgICBpZiAocGFyc2VyLnVuc2V0X25vdF9hbGxvd2VkKCdzYXZlJywgc2NoZW1hLCBmaWVsZE5hbWUsIGNhbGxiYWNrKSkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZGVudGlmaWVycy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCInLCBmaWVsZE5hbWUpKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGRiVmFsKSAmJiBkYlZhbC5xdWVyeV9zZWdtZW50KSB7XG4gICAgICAgIHZhbHVlcy5wdXNoKGRiVmFsLnF1ZXJ5X3NlZ21lbnQpO1xuICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YWx1ZXMucHVzaChkYlZhbCk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGUsIGNhbGxiYWNrKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH0pO1xuXG4gIHJldHVybiB7XG4gICAgaWRlbnRpZmllcnMsXG4gICAgdmFsdWVzLFxuICAgIHF1ZXJ5UGFyYW1zLFxuICAgIGVycm9ySGFwcGVuZWQsXG4gIH07XG59O1xuXG5wYXJzZXIuZXh0cmFjdF9xdWVyeV9yZWxhdGlvbnMgPSBmdW5jdGlvbiBmKGZpZWxkTmFtZSwgcmVsYXRpb25LZXksIHJlbGF0aW9uVmFsdWUsIHNjaGVtYSwgdmFsaWRPcGVyYXRvcnMpIHtcbiAgY29uc3QgcXVlcnlSZWxhdGlvbnMgPSBbXTtcbiAgY29uc3QgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBpZiAoIV8uaGFzKHZhbGlkT3BlcmF0b3JzLCByZWxhdGlvbktleS50b0xvd2VyQ2FzZSgpKSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRvcCcsIHJlbGF0aW9uS2V5KSk7XG4gIH1cblxuICByZWxhdGlvbktleSA9IHJlbGF0aW9uS2V5LnRvTG93ZXJDYXNlKCk7XG4gIGlmIChyZWxhdGlvbktleSA9PT0gJyRpbicgJiYgIV8uaXNBcnJheShyZWxhdGlvblZhbHVlKSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRpbm9wJykpO1xuICB9XG4gIGlmIChyZWxhdGlvbktleSA9PT0gJyR0b2tlbicgJiYgIShyZWxhdGlvblZhbHVlIGluc3RhbmNlb2YgT2JqZWN0KSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWR0b2tlbicpKTtcbiAgfVxuXG4gIGxldCBvcGVyYXRvciA9IHZhbGlkT3BlcmF0b3JzW3JlbGF0aW9uS2V5XTtcbiAgbGV0IHdoZXJlVGVtcGxhdGUgPSAnXCIlc1wiICVzICVzJztcblxuICBjb25zdCBidWlsZFF1ZXJ5UmVsYXRpb25zID0gKGZpZWxkTmFtZUxvY2FsLCByZWxhdGlvblZhbHVlTG9jYWwpID0+IHtcbiAgICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZUxvY2FsLCByZWxhdGlvblZhbHVlTG9jYWwpO1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHtcbiAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoXG4gICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgIGZpZWxkTmFtZUxvY2FsLCBvcGVyYXRvciwgZGJWYWwucXVlcnlfc2VnbWVudCxcbiAgICAgICkpO1xuICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKFxuICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICBmaWVsZE5hbWVMb2NhbCwgb3BlcmF0b3IsIGRiVmFsLFxuICAgICAgKSk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGJ1aWxkVG9rZW5RdWVyeVJlbGF0aW9ucyA9ICh0b2tlblJlbGF0aW9uS2V5LCB0b2tlblJlbGF0aW9uVmFsdWUpID0+IHtcbiAgICB0b2tlblJlbGF0aW9uS2V5ID0gdG9rZW5SZWxhdGlvbktleS50b0xvd2VyQ2FzZSgpO1xuICAgIGlmIChfLmhhcyh2YWxpZE9wZXJhdG9ycywgdG9rZW5SZWxhdGlvbktleSkgJiYgdG9rZW5SZWxhdGlvbktleSAhPT0gJyR0b2tlbicgJiYgdG9rZW5SZWxhdGlvbktleSAhPT0gJyRpbicpIHtcbiAgICAgIG9wZXJhdG9yID0gdmFsaWRPcGVyYXRvcnNbdG9rZW5SZWxhdGlvbktleV07XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWR0b2tlbm9wJywgdG9rZW5SZWxhdGlvbktleSkpO1xuICAgIH1cblxuICAgIGlmIChfLmlzQXJyYXkodG9rZW5SZWxhdGlvblZhbHVlKSkge1xuICAgICAgY29uc3QgdG9rZW5LZXlzID0gZmllbGROYW1lLnNwbGl0KCcsJyk7XG4gICAgICBmb3IgKGxldCB0b2tlbkluZGV4ID0gMDsgdG9rZW5JbmRleCA8IHRva2VuUmVsYXRpb25WYWx1ZS5sZW5ndGg7IHRva2VuSW5kZXgrKykge1xuICAgICAgICB0b2tlbktleXNbdG9rZW5JbmRleF0gPSB0b2tlbktleXNbdG9rZW5JbmRleF0udHJpbSgpO1xuICAgICAgICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIHRva2VuS2V5c1t0b2tlbkluZGV4XSwgdG9rZW5SZWxhdGlvblZhbHVlW3Rva2VuSW5kZXhdKTtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgICAgICAgIHRva2VuUmVsYXRpb25WYWx1ZVt0b2tlbkluZGV4XSA9IGRiVmFsLnF1ZXJ5X3NlZ21lbnQ7XG4gICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRva2VuUmVsYXRpb25WYWx1ZVt0b2tlbkluZGV4XSA9IGRiVmFsO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICB0b2tlbktleXMuam9pbignXCIsXCInKSwgb3BlcmF0b3IsIHRva2VuUmVsYXRpb25WYWx1ZS50b1N0cmluZygpLFxuICAgICAgKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGJ1aWxkUXVlcnlSZWxhdGlvbnMoZmllbGROYW1lLCB0b2tlblJlbGF0aW9uVmFsdWUpO1xuICAgIH1cbiAgfTtcblxuICBpZiAocmVsYXRpb25LZXkgPT09ICckdG9rZW4nKSB7XG4gICAgd2hlcmVUZW1wbGF0ZSA9ICd0b2tlbihcIiVzXCIpICVzIHRva2VuKCVzKSc7XG5cbiAgICBjb25zdCB0b2tlblJlbGF0aW9uS2V5cyA9IE9iamVjdC5rZXlzKHJlbGF0aW9uVmFsdWUpO1xuICAgIGZvciAobGV0IHRva2VuUksgPSAwOyB0b2tlblJLIDwgdG9rZW5SZWxhdGlvbktleXMubGVuZ3RoOyB0b2tlblJLKyspIHtcbiAgICAgIGNvbnN0IHRva2VuUmVsYXRpb25LZXkgPSB0b2tlblJlbGF0aW9uS2V5c1t0b2tlblJLXTtcbiAgICAgIGNvbnN0IHRva2VuUmVsYXRpb25WYWx1ZSA9IHJlbGF0aW9uVmFsdWVbdG9rZW5SZWxhdGlvbktleV07XG4gICAgICBidWlsZFRva2VuUXVlcnlSZWxhdGlvbnModG9rZW5SZWxhdGlvbktleSwgdG9rZW5SZWxhdGlvblZhbHVlKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAocmVsYXRpb25LZXkgPT09ICckY29udGFpbnMnKSB7XG4gICAgY29uc3QgZmllbGRUeXBlMSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBmaWVsZE5hbWUpO1xuICAgIGlmIChbJ21hcCcsICdsaXN0JywgJ3NldCcsICdmcm96ZW4nXS5pbmNsdWRlcyhmaWVsZFR5cGUxKSkge1xuICAgICAgaWYgKGZpZWxkVHlwZTEgPT09ICdtYXAnICYmIF8uaXNQbGFpbk9iamVjdChyZWxhdGlvblZhbHVlKSkge1xuICAgICAgICBPYmplY3Qua2V5cyhyZWxhdGlvblZhbHVlKS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKFxuICAgICAgICAgICAgJ1wiJXNcIlslc10gJXMgJXMnLFxuICAgICAgICAgICAgZmllbGROYW1lLCAnPycsICc9JywgJz8nLFxuICAgICAgICAgICkpO1xuICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goa2V5KTtcbiAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKHJlbGF0aW9uVmFsdWVba2V5XSk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZShcbiAgICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICAgIGZpZWxkTmFtZSwgb3BlcmF0b3IsICc/JyxcbiAgICAgICAgKSk7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2gocmVsYXRpb25WYWx1ZSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRjb250YWluc29wJykpO1xuICAgIH1cbiAgfSBlbHNlIGlmIChyZWxhdGlvbktleSA9PT0gJyRjb250YWluc19rZXknKSB7XG4gICAgY29uc3QgZmllbGRUeXBlMiA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBmaWVsZE5hbWUpO1xuICAgIGlmIChmaWVsZFR5cGUyICE9PSAnbWFwJykge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZGNvbnRhaW5za2V5b3AnKSk7XG4gICAgfVxuICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgZmllbGROYW1lLCBvcGVyYXRvciwgJz8nLFxuICAgICkpO1xuICAgIHF1ZXJ5UGFyYW1zLnB1c2gocmVsYXRpb25WYWx1ZSk7XG4gIH0gZWxzZSB7XG4gICAgYnVpbGRRdWVyeVJlbGF0aW9ucyhmaWVsZE5hbWUsIHJlbGF0aW9uVmFsdWUpO1xuICB9XG4gIHJldHVybiB7IHF1ZXJ5UmVsYXRpb25zLCBxdWVyeVBhcmFtcyB9O1xufTtcblxucGFyc2VyLl9wYXJzZV9xdWVyeV9vYmplY3QgPSBmdW5jdGlvbiBmKHNjaGVtYSwgcXVlcnlPYmplY3QpIHtcbiAgbGV0IHF1ZXJ5UmVsYXRpb25zID0gW107XG4gIGxldCBxdWVyeVBhcmFtcyA9IFtdO1xuXG4gIE9iamVjdC5rZXlzKHF1ZXJ5T2JqZWN0KS5mb3JFYWNoKChmaWVsZE5hbWUpID0+IHtcbiAgICBpZiAoZmllbGROYW1lLnN0YXJ0c1dpdGgoJyQnKSkge1xuICAgICAgLy8gc2VhcmNoIHF1ZXJpZXMgYmFzZWQgb24gbHVjZW5lIGluZGV4IG9yIHNvbHJcbiAgICAgIC8vIGVzY2FwZSBhbGwgc2luZ2xlIHF1b3RlcyBmb3IgcXVlcmllcyBpbiBjYXNzYW5kcmFcbiAgICAgIGlmIChmaWVsZE5hbWUgPT09ICckZXhwcicpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBxdWVyeU9iamVjdFtmaWVsZE5hbWVdLmluZGV4ID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgcXVlcnlPYmplY3RbZmllbGROYW1lXS5xdWVyeSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgXCJleHByKCVzLCclcycpXCIsXG4gICAgICAgICAgICBxdWVyeU9iamVjdFtmaWVsZE5hbWVdLmluZGV4LCBxdWVyeU9iamVjdFtmaWVsZE5hbWVdLnF1ZXJ5LnJlcGxhY2UoLycvZywgXCInJ1wiKSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkZXhwcicpKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChmaWVsZE5hbWUgPT09ICckc29scl9xdWVyeScpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBxdWVyeU9iamVjdFtmaWVsZE5hbWVdID09PSAnc3RyaW5nJykge1xuICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgICAgICBcInNvbHJfcXVlcnk9JyVzJ1wiLFxuICAgICAgICAgICAgcXVlcnlPYmplY3RbZmllbGROYW1lXS5yZXBsYWNlKC8nL2csIFwiJydcIiksXG4gICAgICAgICAgKSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZHNvbHJxdWVyeScpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxldCB3aGVyZU9iamVjdCA9IHF1ZXJ5T2JqZWN0W2ZpZWxkTmFtZV07XG4gICAgLy8gQXJyYXkgb2Ygb3BlcmF0b3JzXG4gICAgaWYgKCFfLmlzQXJyYXkod2hlcmVPYmplY3QpKSB3aGVyZU9iamVjdCA9IFt3aGVyZU9iamVjdF07XG5cbiAgICBmb3IgKGxldCBmayA9IDA7IGZrIDwgd2hlcmVPYmplY3QubGVuZ3RoOyBmaysrKSB7XG4gICAgICBsZXQgZmllbGRSZWxhdGlvbiA9IHdoZXJlT2JqZWN0W2ZrXTtcblxuICAgICAgY29uc3QgY3FsT3BlcmF0b3JzID0ge1xuICAgICAgICAkZXE6ICc9JyxcbiAgICAgICAgJG5lOiAnIT0nLFxuICAgICAgICAkaXNudDogJ0lTIE5PVCcsXG4gICAgICAgICRndDogJz4nLFxuICAgICAgICAkbHQ6ICc8JyxcbiAgICAgICAgJGd0ZTogJz49JyxcbiAgICAgICAgJGx0ZTogJzw9JyxcbiAgICAgICAgJGluOiAnSU4nLFxuICAgICAgICAkbGlrZTogJ0xJS0UnLFxuICAgICAgICAkdG9rZW46ICd0b2tlbicsXG4gICAgICAgICRjb250YWluczogJ0NPTlRBSU5TJyxcbiAgICAgICAgJGNvbnRhaW5zX2tleTogJ0NPTlRBSU5TIEtFWScsXG4gICAgICB9O1xuXG4gICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGZpZWxkUmVsYXRpb24pKSB7XG4gICAgICAgIGNvbnN0IHZhbGlkS2V5cyA9IE9iamVjdC5rZXlzKGNxbE9wZXJhdG9ycyk7XG4gICAgICAgIGNvbnN0IGZpZWxkUmVsYXRpb25LZXlzID0gT2JqZWN0LmtleXMoZmllbGRSZWxhdGlvbik7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZmllbGRSZWxhdGlvbktleXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICBpZiAoIXZhbGlkS2V5cy5pbmNsdWRlcyhmaWVsZFJlbGF0aW9uS2V5c1tpXSkpIHtcbiAgICAgICAgICAgIC8vIGZpZWxkIHJlbGF0aW9uIGtleSBpbnZhbGlkLCBhcHBseSBkZWZhdWx0ICRlcSBvcGVyYXRvclxuICAgICAgICAgICAgZmllbGRSZWxhdGlvbiA9IHsgJGVxOiBmaWVsZFJlbGF0aW9uIH07XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZpZWxkUmVsYXRpb24gPSB7ICRlcTogZmllbGRSZWxhdGlvbiB9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCByZWxhdGlvbktleXMgPSBPYmplY3Qua2V5cyhmaWVsZFJlbGF0aW9uKTtcbiAgICAgIGZvciAobGV0IHJrID0gMDsgcmsgPCByZWxhdGlvbktleXMubGVuZ3RoOyByaysrKSB7XG4gICAgICAgIGNvbnN0IHJlbGF0aW9uS2V5ID0gcmVsYXRpb25LZXlzW3JrXTtcbiAgICAgICAgY29uc3QgcmVsYXRpb25WYWx1ZSA9IGZpZWxkUmVsYXRpb25bcmVsYXRpb25LZXldO1xuICAgICAgICBjb25zdCBleHRyYWN0ZWRSZWxhdGlvbnMgPSBwYXJzZXIuZXh0cmFjdF9xdWVyeV9yZWxhdGlvbnMoXG4gICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgIHJlbGF0aW9uS2V5LFxuICAgICAgICAgIHJlbGF0aW9uVmFsdWUsXG4gICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgIGNxbE9wZXJhdG9ycyxcbiAgICAgICAgKTtcbiAgICAgICAgcXVlcnlSZWxhdGlvbnMgPSBxdWVyeVJlbGF0aW9ucy5jb25jYXQoZXh0cmFjdGVkUmVsYXRpb25zLnF1ZXJ5UmVsYXRpb25zKTtcbiAgICAgICAgcXVlcnlQYXJhbXMgPSBxdWVyeVBhcmFtcy5jb25jYXQoZXh0cmFjdGVkUmVsYXRpb25zLnF1ZXJ5UGFyYW1zKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiB7IHF1ZXJ5UmVsYXRpb25zLCBxdWVyeVBhcmFtcyB9O1xufTtcblxucGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlID0gZnVuY3Rpb24gZihzY2hlbWEsIHF1ZXJ5T2JqZWN0LCBjbGF1c2UpIHtcbiAgY29uc3QgcGFyc2VkT2JqZWN0ID0gcGFyc2VyLl9wYXJzZV9xdWVyeV9vYmplY3Qoc2NoZW1hLCBxdWVyeU9iamVjdCk7XG4gIGNvbnN0IGZpbHRlckNsYXVzZSA9IHt9O1xuICBpZiAocGFyc2VkT2JqZWN0LnF1ZXJ5UmVsYXRpb25zLmxlbmd0aCA+IDApIHtcbiAgICBmaWx0ZXJDbGF1c2UucXVlcnkgPSB1dGlsLmZvcm1hdCgnJXMgJXMnLCBjbGF1c2UsIHBhcnNlZE9iamVjdC5xdWVyeVJlbGF0aW9ucy5qb2luKCcgQU5EICcpKTtcbiAgfSBlbHNlIHtcbiAgICBmaWx0ZXJDbGF1c2UucXVlcnkgPSAnJztcbiAgfVxuICBmaWx0ZXJDbGF1c2UucGFyYW1zID0gcGFyc2VkT2JqZWN0LnF1ZXJ5UGFyYW1zO1xuICByZXR1cm4gZmlsdGVyQ2xhdXNlO1xufTtcblxucGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlX2RkbCA9IGZ1bmN0aW9uIGYoc2NoZW1hLCBxdWVyeU9iamVjdCwgY2xhdXNlKSB7XG4gIGNvbnN0IGZpbHRlckNsYXVzZSA9IHBhcnNlci5nZXRfZmlsdGVyX2NsYXVzZShzY2hlbWEsIHF1ZXJ5T2JqZWN0LCBjbGF1c2UpO1xuICBsZXQgZmlsdGVyUXVlcnkgPSBmaWx0ZXJDbGF1c2UucXVlcnk7XG4gIGZpbHRlckNsYXVzZS5wYXJhbXMuZm9yRWFjaCgocGFyYW0pID0+IHtcbiAgICBsZXQgcXVlcnlQYXJhbTtcbiAgICBpZiAodHlwZW9mIHBhcmFtID09PSAnc3RyaW5nJykge1xuICAgICAgcXVlcnlQYXJhbSA9IHV0aWwuZm9ybWF0KFwiJyVzJ1wiLCBwYXJhbSk7XG4gICAgfSBlbHNlIGlmIChwYXJhbSBpbnN0YW5jZW9mIERhdGUpIHtcbiAgICAgIHF1ZXJ5UGFyYW0gPSB1dGlsLmZvcm1hdChcIiclcydcIiwgcGFyYW0udG9JU09TdHJpbmcoKSk7XG4gICAgfSBlbHNlIGlmIChwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5Mb25nXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5JbnRlZ2VyXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5CaWdEZWNpbWFsXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5UaW1lVXVpZFxuICAgICAgfHwgcGFyYW0gaW5zdGFuY2VvZiBjcWwudHlwZXMuVXVpZCkge1xuICAgICAgcXVlcnlQYXJhbSA9IHBhcmFtLnRvU3RyaW5nKCk7XG4gICAgfSBlbHNlIGlmIChwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5Mb2NhbERhdGVcbiAgICAgIHx8IHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLkxvY2FsVGltZVxuICAgICAgfHwgcGFyYW0gaW5zdGFuY2VvZiBjcWwudHlwZXMuSW5ldEFkZHJlc3MpIHtcbiAgICAgIHF1ZXJ5UGFyYW0gPSB1dGlsLmZvcm1hdChcIiclcydcIiwgcGFyYW0udG9TdHJpbmcoKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHF1ZXJ5UGFyYW0gPSBwYXJhbTtcbiAgICB9XG4gICAgLy8gVE9ETzogdW5oYW5kbGVkIGlmIHF1ZXJ5UGFyYW0gaXMgYSBzdHJpbmcgY29udGFpbmluZyA/IGNoYXJhY3RlclxuICAgIC8vIHRob3VnaCB0aGlzIGlzIHVubGlrZWx5IHRvIGhhdmUgaW4gbWF0ZXJpYWxpemVkIHZpZXcgZmlsdGVycywgYnV0Li4uXG4gICAgZmlsdGVyUXVlcnkgPSBmaWx0ZXJRdWVyeS5yZXBsYWNlKCc/JywgcXVlcnlQYXJhbSk7XG4gIH0pO1xuICByZXR1cm4gZmlsdGVyUXVlcnk7XG59O1xuXG5wYXJzZXIuZ2V0X3doZXJlX2NsYXVzZSA9IGZ1bmN0aW9uIGYoc2NoZW1hLCBxdWVyeU9iamVjdCkge1xuICByZXR1cm4gcGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlKHNjaGVtYSwgcXVlcnlPYmplY3QsICdXSEVSRScpO1xufTtcblxucGFyc2VyLmdldF9pZl9jbGF1c2UgPSBmdW5jdGlvbiBmKHNjaGVtYSwgcXVlcnlPYmplY3QpIHtcbiAgcmV0dXJuIHBhcnNlci5nZXRfZmlsdGVyX2NsYXVzZShzY2hlbWEsIHF1ZXJ5T2JqZWN0LCAnSUYnKTtcbn07XG5cbnBhcnNlci5nZXRfcHJpbWFyeV9rZXlfY2xhdXNlcyA9IGZ1bmN0aW9uIGYoc2NoZW1hKSB7XG4gIGNvbnN0IHBhcnRpdGlvbktleSA9IHNjaGVtYS5rZXlbMF07XG4gIGxldCBjbHVzdGVyaW5nS2V5ID0gc2NoZW1hLmtleS5zbGljZSgxLCBzY2hlbWEua2V5Lmxlbmd0aCk7XG4gIGNvbnN0IGNsdXN0ZXJpbmdPcmRlciA9IFtdO1xuXG4gIGZvciAobGV0IGZpZWxkID0gMDsgZmllbGQgPCBjbHVzdGVyaW5nS2V5Lmxlbmd0aDsgZmllbGQrKykge1xuICAgIGlmIChzY2hlbWEuY2x1c3RlcmluZ19vcmRlclxuICAgICAgICAmJiBzY2hlbWEuY2x1c3RlcmluZ19vcmRlcltjbHVzdGVyaW5nS2V5W2ZpZWxkXV1cbiAgICAgICAgJiYgc2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbY2x1c3RlcmluZ0tleVtmaWVsZF1dLnRvTG93ZXJDYXNlKCkgPT09ICdkZXNjJykge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIiBERVNDJywgY2x1c3RlcmluZ0tleVtmaWVsZF0pKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIiBBU0MnLCBjbHVzdGVyaW5nS2V5W2ZpZWxkXSkpO1xuICAgIH1cbiAgfVxuXG4gIGxldCBjbHVzdGVyaW5nT3JkZXJDbGF1c2UgPSAnJztcbiAgaWYgKGNsdXN0ZXJpbmdPcmRlci5sZW5ndGggPiAwKSB7XG4gICAgY2x1c3RlcmluZ09yZGVyQ2xhdXNlID0gdXRpbC5mb3JtYXQoJyBXSVRIIENMVVNURVJJTkcgT1JERVIgQlkgKCVzKScsIGNsdXN0ZXJpbmdPcmRlci50b1N0cmluZygpKTtcbiAgfVxuXG4gIGxldCBwYXJ0aXRpb25LZXlDbGF1c2UgPSAnJztcbiAgaWYgKF8uaXNBcnJheShwYXJ0aXRpb25LZXkpKSB7XG4gICAgcGFydGl0aW9uS2V5Q2xhdXNlID0gcGFydGl0aW9uS2V5Lm1hcCgodikgPT4gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHYpKS5qb2luKCcsJyk7XG4gIH0gZWxzZSB7XG4gICAgcGFydGl0aW9uS2V5Q2xhdXNlID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHBhcnRpdGlvbktleSk7XG4gIH1cblxuICBsZXQgY2x1c3RlcmluZ0tleUNsYXVzZSA9ICcnO1xuICBpZiAoY2x1c3RlcmluZ0tleS5sZW5ndGgpIHtcbiAgICBjbHVzdGVyaW5nS2V5ID0gY2x1c3RlcmluZ0tleS5tYXAoKHYpID0+IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCInLCB2KSkuam9pbignLCcpO1xuICAgIGNsdXN0ZXJpbmdLZXlDbGF1c2UgPSB1dGlsLmZvcm1hdCgnLCVzJywgY2x1c3RlcmluZ0tleSk7XG4gIH1cblxuICByZXR1cm4geyBwYXJ0aXRpb25LZXlDbGF1c2UsIGNsdXN0ZXJpbmdLZXlDbGF1c2UsIGNsdXN0ZXJpbmdPcmRlckNsYXVzZSB9O1xufTtcblxucGFyc2VyLmdldF9tdmlld193aGVyZV9jbGF1c2UgPSBmdW5jdGlvbiBmKHNjaGVtYSwgdmlld1NjaGVtYSkge1xuICBjb25zdCBjbGF1c2VzID0gcGFyc2VyLmdldF9wcmltYXJ5X2tleV9jbGF1c2VzKHZpZXdTY2hlbWEpO1xuICBsZXQgd2hlcmVDbGF1c2UgPSBjbGF1c2VzLnBhcnRpdGlvbktleUNsYXVzZS5zcGxpdCgnLCcpLmpvaW4oJyBJUyBOT1QgTlVMTCBBTkQgJyk7XG4gIGlmIChjbGF1c2VzLmNsdXN0ZXJpbmdLZXlDbGF1c2UpIHdoZXJlQ2xhdXNlICs9IGNsYXVzZXMuY2x1c3RlcmluZ0tleUNsYXVzZS5zcGxpdCgnLCcpLmpvaW4oJyBJUyBOT1QgTlVMTCBBTkQgJyk7XG4gIHdoZXJlQ2xhdXNlICs9ICcgSVMgTk9UIE5VTEwnO1xuXG4gIGNvbnN0IGZpbHRlcnMgPSBfLmNsb25lRGVlcCh2aWV3U2NoZW1hLmZpbHRlcnMpO1xuXG4gIGlmIChfLmlzUGxhaW5PYmplY3QoZmlsdGVycykpIHtcbiAgICAvLyBkZWxldGUgcHJpbWFyeSBrZXkgZmllbGRzIGRlZmluZWQgYXMgaXNuJ3QgbnVsbCBpbiBmaWx0ZXJzXG4gICAgT2JqZWN0LmtleXMoZmlsdGVycykuZm9yRWFjaCgoZmlsdGVyS2V5KSA9PiB7XG4gICAgICBpZiAoZmlsdGVyc1tmaWx0ZXJLZXldLiRpc250ID09PSBudWxsXG4gICAgICAgICAgJiYgKHZpZXdTY2hlbWEua2V5LmluY2x1ZGVzKGZpbHRlcktleSkgfHwgdmlld1NjaGVtYS5rZXlbMF0uaW5jbHVkZXMoZmlsdGVyS2V5KSkpIHtcbiAgICAgICAgZGVsZXRlIGZpbHRlcnNbZmlsdGVyS2V5XS4kaXNudDtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGNvbnN0IGZpbHRlckNsYXVzZSA9IHBhcnNlci5nZXRfZmlsdGVyX2NsYXVzZV9kZGwoc2NoZW1hLCBmaWx0ZXJzLCAnQU5EJyk7XG4gICAgd2hlcmVDbGF1c2UgKz0gdXRpbC5mb3JtYXQoJyAlcycsIGZpbHRlckNsYXVzZSkucmVwbGFjZSgvSVMgTk9UIG51bGwvZywgJ0lTIE5PVCBOVUxMJyk7XG4gIH1cblxuICAvLyByZW1vdmUgdW5uZWNlc3NhcmlseSBxdW90ZWQgZmllbGQgbmFtZXMgaW4gZ2VuZXJhdGVkIHdoZXJlIGNsYXVzZVxuICAvLyBzbyB0aGF0IGl0IG1hdGNoZXMgdGhlIHdoZXJlX2NsYXVzZSBmcm9tIGRhdGFiYXNlIHNjaGVtYVxuICBjb25zdCBxdW90ZWRGaWVsZE5hbWVzID0gd2hlcmVDbGF1c2UubWF0Y2goL1wiKC4qPylcIi9nKTtcbiAgcXVvdGVkRmllbGROYW1lcy5mb3JFYWNoKChmaWVsZE5hbWUpID0+IHtcbiAgICBjb25zdCB1bnF1b3RlZEZpZWxkTmFtZSA9IGZpZWxkTmFtZS5yZXBsYWNlKC9cIi9nLCAnJyk7XG4gICAgY29uc3QgcmVzZXJ2ZWRLZXl3b3JkcyA9IFtcbiAgICAgICdBREQnLCAnQUdHUkVHQVRFJywgJ0FMTE9XJywgJ0FMVEVSJywgJ0FORCcsICdBTlknLCAnQVBQTFknLFxuICAgICAgJ0FTQycsICdBVVRIT1JJWkUnLCAnQkFUQ0gnLCAnQkVHSU4nLCAnQlknLCAnQ09MVU1ORkFNSUxZJyxcbiAgICAgICdDUkVBVEUnLCAnREVMRVRFJywgJ0RFU0MnLCAnRFJPUCcsICdFQUNIX1FVT1JVTScsICdFTlRSSUVTJyxcbiAgICAgICdGUk9NJywgJ0ZVTEwnLCAnR1JBTlQnLCAnSUYnLCAnSU4nLCAnSU5ERVgnLCAnSU5FVCcsICdJTkZJTklUWScsXG4gICAgICAnSU5TRVJUJywgJ0lOVE8nLCAnS0VZU1BBQ0UnLCAnS0VZU1BBQ0VTJywgJ0xJTUlUJywgJ0xPQ0FMX09ORScsXG4gICAgICAnTE9DQUxfUVVPUlVNJywgJ01BVEVSSUFMSVpFRCcsICdNT0RJRlknLCAnTkFOJywgJ05PUkVDVVJTSVZFJyxcbiAgICAgICdOT1QnLCAnT0YnLCAnT04nLCAnT05FJywgJ09SREVSJywgJ1BBUlRJVElPTicsICdQQVNTV09SRCcsICdQRVInLFxuICAgICAgJ1BSSU1BUlknLCAnUVVPUlVNJywgJ1JFTkFNRScsICdSRVZPS0UnLCAnU0NIRU1BJywgJ1NFTEVDVCcsICdTRVQnLFxuICAgICAgJ1RBQkxFJywgJ1RJTUUnLCAnVEhSRUUnLCAnVE8nLCAnVE9LRU4nLCAnVFJVTkNBVEUnLCAnVFdPJywgJ1VOTE9HR0VEJyxcbiAgICAgICdVUERBVEUnLCAnVVNFJywgJ1VTSU5HJywgJ1ZJRVcnLCAnV0hFUkUnLCAnV0lUSCddO1xuICAgIGlmICh1bnF1b3RlZEZpZWxkTmFtZSA9PT0gdW5xdW90ZWRGaWVsZE5hbWUudG9Mb3dlckNhc2UoKVxuICAgICAgJiYgIXJlc2VydmVkS2V5d29yZHMuaW5jbHVkZXModW5xdW90ZWRGaWVsZE5hbWUudG9VcHBlckNhc2UoKSkpIHtcbiAgICAgIHdoZXJlQ2xhdXNlID0gd2hlcmVDbGF1c2UucmVwbGFjZShmaWVsZE5hbWUsIHVucXVvdGVkRmllbGROYW1lKTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gd2hlcmVDbGF1c2U7XG59O1xuXG5wYXJzZXIuZ2V0X29yZGVyYnlfY2xhdXNlID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCkge1xuICBjb25zdCBvcmRlcktleXMgPSBbXTtcbiAgT2JqZWN0LmtleXMocXVlcnlPYmplY3QpLmZvckVhY2goKGspID0+IHtcbiAgICBjb25zdCBxdWVyeUl0ZW0gPSBxdWVyeU9iamVjdFtrXTtcbiAgICBpZiAoay50b0xvd2VyQ2FzZSgpID09PSAnJG9yZGVyYnknKSB7XG4gICAgICBpZiAoIShxdWVyeUl0ZW0gaW5zdGFuY2VvZiBPYmplY3QpKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRvcmRlcicpKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG9yZGVySXRlbUtleXMgPSBPYmplY3Qua2V5cyhxdWVyeUl0ZW0pO1xuXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG9yZGVySXRlbUtleXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY29uc3QgY3FsT3JkZXJEaXJlY3Rpb24gPSB7ICRhc2M6ICdBU0MnLCAkZGVzYzogJ0RFU0MnIH07XG4gICAgICAgIGlmIChvcmRlckl0ZW1LZXlzW2ldLnRvTG93ZXJDYXNlKCkgaW4gY3FsT3JkZXJEaXJlY3Rpb24pIHtcbiAgICAgICAgICBsZXQgb3JkZXJGaWVsZHMgPSBxdWVyeUl0ZW1bb3JkZXJJdGVtS2V5c1tpXV07XG5cbiAgICAgICAgICBpZiAoIV8uaXNBcnJheShvcmRlckZpZWxkcykpIHtcbiAgICAgICAgICAgIG9yZGVyRmllbGRzID0gW29yZGVyRmllbGRzXTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBmb3IgKGxldCBqID0gMDsgaiA8IG9yZGVyRmllbGRzLmxlbmd0aDsgaisrKSB7XG4gICAgICAgICAgICBvcmRlcktleXMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZShcbiAgICAgICAgICAgICAgJ1wiJXNcIiAlcycsXG4gICAgICAgICAgICAgIG9yZGVyRmllbGRzW2pdLCBjcWxPcmRlckRpcmVjdGlvbltvcmRlckl0ZW1LZXlzW2ldXSxcbiAgICAgICAgICAgICkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkb3JkZXJ0eXBlJywgb3JkZXJJdGVtS2V5c1tpXSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIG9yZGVyS2V5cy5sZW5ndGggPyB1dGlsLmZvcm1hdCgnT1JERVIgQlkgJXMnLCBvcmRlcktleXMuam9pbignLCAnKSkgOiAnICc7XG59O1xuXG5wYXJzZXIuZ2V0X2dyb3VwYnlfY2xhdXNlID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCkge1xuICBsZXQgZ3JvdXBieUtleXMgPSBbXTtcblxuICBPYmplY3Qua2V5cyhxdWVyeU9iamVjdCkuZm9yRWFjaCgoaykgPT4ge1xuICAgIGNvbnN0IHF1ZXJ5SXRlbSA9IHF1ZXJ5T2JqZWN0W2tdO1xuXG4gICAgaWYgKGsudG9Mb3dlckNhc2UoKSA9PT0gJyRncm91cGJ5Jykge1xuICAgICAgaWYgKCEocXVlcnlJdGVtIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRncm91cCcpKTtcbiAgICAgIH1cblxuICAgICAgZ3JvdXBieUtleXMgPSBncm91cGJ5S2V5cy5jb25jYXQocXVlcnlJdGVtKTtcbiAgICB9XG4gIH0pO1xuXG4gIGdyb3VwYnlLZXlzID0gZ3JvdXBieUtleXMubWFwKChrZXkpID0+IGBcIiR7a2V5fVwiYCk7XG5cbiAgcmV0dXJuIGdyb3VwYnlLZXlzLmxlbmd0aCA/IHV0aWwuZm9ybWF0KCdHUk9VUCBCWSAlcycsIGdyb3VwYnlLZXlzLmpvaW4oJywgJykpIDogJyAnO1xufTtcblxucGFyc2VyLmdldF9saW1pdF9jbGF1c2UgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0KSB7XG4gIGxldCBsaW1pdCA9IG51bGw7XG4gIE9iamVjdC5rZXlzKHF1ZXJ5T2JqZWN0KS5mb3JFYWNoKChrKSA9PiB7XG4gICAgY29uc3QgcXVlcnlJdGVtID0gcXVlcnlPYmplY3Rba107XG4gICAgaWYgKGsudG9Mb3dlckNhc2UoKSA9PT0gJyRsaW1pdCcpIHtcbiAgICAgIGlmICh0eXBlb2YgcXVlcnlJdGVtICE9PSAnbnVtYmVyJykgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQubGltaXR0eXBlJykpO1xuICAgICAgbGltaXQgPSBxdWVyeUl0ZW07XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIGxpbWl0ID8gdXRpbC5mb3JtYXQoJ0xJTUlUICVzJywgbGltaXQpIDogJyAnO1xufTtcblxucGFyc2VyLmdldF9zZWxlY3RfY2xhdXNlID0gZnVuY3Rpb24gZihvcHRpb25zKSB7XG4gIGxldCBzZWxlY3RDbGF1c2UgPSAnKic7XG4gIGlmIChvcHRpb25zLnNlbGVjdCAmJiBfLmlzQXJyYXkob3B0aW9ucy5zZWxlY3QpICYmIG9wdGlvbnMuc2VsZWN0Lmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBzZWxlY3RBcnJheSA9IFtdO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgb3B0aW9ucy5zZWxlY3QubGVuZ3RoOyBpKyspIHtcbiAgICAgIC8vIHNlcGFyYXRlIHRoZSBhZ2dyZWdhdGUgZnVuY3Rpb24gYW5kIHRoZSBjb2x1bW4gbmFtZSBpZiBzZWxlY3QgaXMgYW4gYWdncmVnYXRlIGZ1bmN0aW9uXG4gICAgICBjb25zdCBzZWxlY3Rpb24gPSBvcHRpb25zLnNlbGVjdFtpXS5zcGxpdCgvWygsICldL2cpLmZpbHRlcigoZSkgPT4gKGUpKTtcbiAgICAgIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAxKSB7XG4gICAgICAgIGlmIChzZWxlY3Rpb25bMF0gPT09ICcqJykgc2VsZWN0QXJyYXkucHVzaCgnKicpO1xuICAgICAgICBlbHNlIHNlbGVjdEFycmF5LnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHNlbGVjdGlvblswXSkpO1xuICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAyKSB7XG4gICAgICAgIHNlbGVjdEFycmF5LnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJyVzKFwiJXNcIiknLCBzZWxlY3Rpb25bMF0sIHNlbGVjdGlvblsxXSkpO1xuICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID49IDMgJiYgc2VsZWN0aW9uW3NlbGVjdGlvbi5sZW5ndGggLSAyXS50b0xvd2VyQ2FzZSgpID09PSAnYXMnKSB7XG4gICAgICAgIGNvbnN0IHNlbGVjdGlvbkVuZENodW5rID0gc2VsZWN0aW9uLnNwbGljZShzZWxlY3Rpb24ubGVuZ3RoIC0gMik7XG4gICAgICAgIGxldCBzZWxlY3Rpb25DaHVuayA9ICcnO1xuICAgICAgICBpZiAoc2VsZWN0aW9uLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgIHNlbGVjdGlvbkNodW5rID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHNlbGVjdGlvblswXSk7XG4gICAgICAgIH0gZWxzZSBpZiAoc2VsZWN0aW9uLmxlbmd0aCA9PT0gMikge1xuICAgICAgICAgIHNlbGVjdGlvbkNodW5rID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJyVzKFwiJXNcIiknLCBzZWxlY3Rpb25bMF0sIHNlbGVjdGlvblsxXSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc2VsZWN0aW9uQ2h1bmsgPSB1dGlsLmZvcm1hdCgnJXMoJXMpJywgc2VsZWN0aW9uWzBdLCBgXCIke3NlbGVjdGlvbi5zcGxpY2UoMSkuam9pbignXCIsXCInKX1cImApO1xuICAgICAgICB9XG4gICAgICAgIHNlbGVjdEFycmF5LnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJyVzIEFTIFwiJXNcIicsIHNlbGVjdGlvbkNodW5rLCBzZWxlY3Rpb25FbmRDaHVua1sxXSkpO1xuICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID49IDMpIHtcbiAgICAgICAgc2VsZWN0QXJyYXkucHVzaCh1dGlsLmZvcm1hdCgnJXMoJXMpJywgc2VsZWN0aW9uWzBdLCBgXCIke3NlbGVjdGlvbi5zcGxpY2UoMSkuam9pbignXCIsXCInKX1cImApKTtcbiAgICAgIH1cbiAgICB9XG4gICAgc2VsZWN0Q2xhdXNlID0gc2VsZWN0QXJyYXkuam9pbignLCcpO1xuICB9XG4gIHJldHVybiBzZWxlY3RDbGF1c2U7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IHBhcnNlcjtcbiJdfQ==