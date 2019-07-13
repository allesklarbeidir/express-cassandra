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
var setCharAt = function setCharAt(str, index, chr) {
  return str.substr(0, index) + chr + str.substr(index + 1);
};

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
        formatString = setCharAt(formatString, fp.index - 1, " ");
        formatString = setCharAt(formatString, fp.index + 2, " ");
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9wYXJzZXIuanMiXSwibmFtZXMiOlsiUHJvbWlzZSIsInJlcXVpcmUiLCJfIiwidXRpbCIsImRzZURyaXZlciIsImUiLCJjcWwiLCJwcm9taXNpZnlBbGwiLCJidWlsZEVycm9yIiwiZGF0YXR5cGVzIiwic2NoZW1lciIsInBhcnNlciIsInNldENoYXJBdCIsInN0ciIsImluZGV4IiwiY2hyIiwic3Vic3RyIiwiZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSIsImZvcm1hdFN0cmluZyIsInBsYWNlaG9sZGVycyIsInJlIiwibWF0Y2giLCJleGVjIiwicHVzaCIsInBhcmFtcyIsImZvckVhY2giLCJwIiwiaSIsImxlbmd0aCIsImluZGV4T2YiLCJmcCIsImZvcm1hdCIsImNhbGxiYWNrX29yX3Rocm93IiwiZiIsImVyciIsImNhbGxiYWNrIiwiZXh0cmFjdF90eXBlIiwidmFsIiwiZGVjb21wb3NlZCIsInJlcGxhY2UiLCJzcGxpdCIsImQiLCJoYXMiLCJleHRyYWN0X3R5cGVEZWYiLCJleHRyYWN0X2FsdGVyZWRfdHlwZSIsIm5vcm1hbGl6ZWRNb2RlbFNjaGVtYSIsImRpZmYiLCJmaWVsZE5hbWUiLCJwYXRoIiwidHlwZSIsInJocyIsImZpZWxkcyIsInR5cGVEZWYiLCJnZXRfZGJfdmFsdWVfZXhwcmVzc2lvbiIsInNjaGVtYSIsImZpZWxkVmFsdWUiLCJ0eXBlcyIsInVuc2V0IiwicXVlcnlfc2VnbWVudCIsInBhcmFtZXRlciIsImlzUGxhaW5PYmplY3QiLCIkZGJfZnVuY3Rpb24iLCJmaWVsZFR5cGUiLCJnZXRfZmllbGRfdHlwZSIsInZhbGlkYXRvcnMiLCJnZXRfdmFsaWRhdG9ycyIsImlzQXJyYXkiLCJtYXAiLCJ2IiwiZGJWYWwiLCJ2YWxpZGF0aW9uTWVzc2FnZSIsImdldF92YWxpZGF0aW9uX21lc3NhZ2UiLCJjb3VudGVyUXVlcnlTZWdtZW50IiwiTWF0aCIsImFicyIsInVuc2V0X25vdF9hbGxvd2VkIiwib3BlcmF0aW9uIiwiaXNfcHJpbWFyeV9rZXlfZmllbGQiLCJpc19yZXF1aXJlZF9maWVsZCIsImdldF9pbnBsYWNlX3VwZGF0ZV9leHByZXNzaW9uIiwidXBkYXRlQ2xhdXNlcyIsInF1ZXJ5UGFyYW1zIiwiJGFkZCIsIiRhcHBlbmQiLCIkcHJlcGVuZCIsIiRyZXBsYWNlIiwiJHJlbW92ZSIsImluY2x1ZGVzIiwiT2JqZWN0Iiwia2V5cyIsInJlcGxhY2VLZXlzIiwicmVwbGFjZVZhbHVlcyIsInZhbHVlcyIsImdldF91cGRhdGVfdmFsdWVfZXhwcmVzc2lvbiIsImluc3RhbmNlIiwidXBkYXRlVmFsdWVzIiwib3B0aW9ucyIsInRpbWVzdGFtcHMiLCJ1cGRhdGVkQXQiLCJ2ZXJzaW9ucyIsImtleSIsImVycm9ySGFwcGVuZWQiLCJzb21lIiwidW5kZWZpbmVkIiwidmlydHVhbCIsIl9nZXRfZGVmYXVsdF92YWx1ZSIsInJ1bGUiLCJpZ25vcmVfZGVmYXVsdCIsInZhbGlkYXRlIiwiZ2V0X3NhdmVfdmFsdWVfZXhwcmVzc2lvbiIsImZuIiwiaWRlbnRpZmllcnMiLCJleHRyYWN0X3F1ZXJ5X3JlbGF0aW9ucyIsInJlbGF0aW9uS2V5IiwicmVsYXRpb25WYWx1ZSIsInZhbGlkT3BlcmF0b3JzIiwicXVlcnlSZWxhdGlvbnMiLCJ0b0xvd2VyQ2FzZSIsIm9wZXJhdG9yIiwid2hlcmVUZW1wbGF0ZSIsImJ1aWxkUXVlcnlSZWxhdGlvbnMiLCJmaWVsZE5hbWVMb2NhbCIsInJlbGF0aW9uVmFsdWVMb2NhbCIsImJ1aWxkVG9rZW5RdWVyeVJlbGF0aW9ucyIsInRva2VuUmVsYXRpb25LZXkiLCJ0b2tlblJlbGF0aW9uVmFsdWUiLCJ0b2tlbktleXMiLCJ0b2tlbkluZGV4IiwidHJpbSIsImpvaW4iLCJ0b1N0cmluZyIsInRva2VuUmVsYXRpb25LZXlzIiwidG9rZW5SSyIsImZpZWxkVHlwZTEiLCJmaWVsZFR5cGUyIiwiX3BhcnNlX3F1ZXJ5X29iamVjdCIsInF1ZXJ5T2JqZWN0Iiwic3RhcnRzV2l0aCIsInF1ZXJ5Iiwid2hlcmVPYmplY3QiLCJmayIsImZpZWxkUmVsYXRpb24iLCJjcWxPcGVyYXRvcnMiLCIkZXEiLCIkbmUiLCIkaXNudCIsIiRndCIsIiRsdCIsIiRndGUiLCIkbHRlIiwiJGluIiwiJGxpa2UiLCIkdG9rZW4iLCIkY29udGFpbnMiLCIkY29udGFpbnNfa2V5IiwidmFsaWRLZXlzIiwiZmllbGRSZWxhdGlvbktleXMiLCJyZWxhdGlvbktleXMiLCJyayIsImV4dHJhY3RlZFJlbGF0aW9ucyIsImNvbmNhdCIsImdldF9maWx0ZXJfY2xhdXNlIiwiY2xhdXNlIiwicGFyc2VkT2JqZWN0IiwiZmlsdGVyQ2xhdXNlIiwiZ2V0X2ZpbHRlcl9jbGF1c2VfZGRsIiwiZmlsdGVyUXVlcnkiLCJwYXJhbSIsInF1ZXJ5UGFyYW0iLCJEYXRlIiwidG9JU09TdHJpbmciLCJMb25nIiwiSW50ZWdlciIsIkJpZ0RlY2ltYWwiLCJUaW1lVXVpZCIsIlV1aWQiLCJMb2NhbERhdGUiLCJMb2NhbFRpbWUiLCJJbmV0QWRkcmVzcyIsImdldF93aGVyZV9jbGF1c2UiLCJnZXRfaWZfY2xhdXNlIiwiZ2V0X3ByaW1hcnlfa2V5X2NsYXVzZXMiLCJwYXJ0aXRpb25LZXkiLCJjbHVzdGVyaW5nS2V5Iiwic2xpY2UiLCJjbHVzdGVyaW5nT3JkZXIiLCJmaWVsZCIsImNsdXN0ZXJpbmdfb3JkZXIiLCJjbHVzdGVyaW5nT3JkZXJDbGF1c2UiLCJwYXJ0aXRpb25LZXlDbGF1c2UiLCJjbHVzdGVyaW5nS2V5Q2xhdXNlIiwiZ2V0X212aWV3X3doZXJlX2NsYXVzZSIsInZpZXdTY2hlbWEiLCJjbGF1c2VzIiwid2hlcmVDbGF1c2UiLCJmaWx0ZXJzIiwiY2xvbmVEZWVwIiwiZmlsdGVyS2V5IiwicXVvdGVkRmllbGROYW1lcyIsInVucXVvdGVkRmllbGROYW1lIiwicmVzZXJ2ZWRLZXl3b3JkcyIsInRvVXBwZXJDYXNlIiwiZ2V0X29yZGVyYnlfY2xhdXNlIiwib3JkZXJLZXlzIiwiayIsInF1ZXJ5SXRlbSIsIm9yZGVySXRlbUtleXMiLCJjcWxPcmRlckRpcmVjdGlvbiIsIiRhc2MiLCIkZGVzYyIsIm9yZGVyRmllbGRzIiwiaiIsImdldF9ncm91cGJ5X2NsYXVzZSIsImdyb3VwYnlLZXlzIiwiQXJyYXkiLCJnZXRfbGltaXRfY2xhdXNlIiwibGltaXQiLCJnZXRfc2VsZWN0X2NsYXVzZSIsInNlbGVjdENsYXVzZSIsInNlbGVjdCIsInNlbGVjdEFycmF5Iiwic2VsZWN0aW9uIiwiZmlsdGVyIiwic2VsZWN0aW9uRW5kQ2h1bmsiLCJzcGxpY2UiLCJzZWxlY3Rpb25DaHVuayIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7O0FBQUEsSUFBTUEsVUFBVUMsUUFBUSxVQUFSLENBQWhCO0FBQ0EsSUFBTUMsSUFBSUQsUUFBUSxRQUFSLENBQVY7QUFDQSxJQUFNRSxPQUFPRixRQUFRLE1BQVIsQ0FBYjs7QUFFQSxJQUFJRyxrQkFBSjtBQUNBLElBQUk7QUFDRjtBQUNBQSxjQUFZSCxRQUFRLFlBQVIsQ0FBWjtBQUNELENBSEQsQ0FHRSxPQUFPSSxDQUFQLEVBQVU7QUFDVkQsY0FBWSxJQUFaO0FBQ0Q7O0FBRUQsSUFBTUUsTUFBTU4sUUFBUU8sWUFBUixDQUFxQkgsYUFBYUgsUUFBUSxrQkFBUixDQUFsQyxDQUFaOztBQUVBLElBQU1PLGFBQWFQLFFBQVEsd0JBQVIsQ0FBbkI7QUFDQSxJQUFNUSxZQUFZUixRQUFRLHlCQUFSLENBQWxCO0FBQ0EsSUFBTVMsVUFBVVQsUUFBUSxzQkFBUixDQUFoQjs7QUFFQSxJQUFNVSxTQUFTLEVBQWY7QUFDQSxJQUFNQyxZQUFZLFNBQVpBLFNBQVksQ0FBQ0MsR0FBRCxFQUFLQyxLQUFMLEVBQVlDLEdBQVo7QUFBQSxTQUFvQkYsSUFBSUcsTUFBSixDQUFXLENBQVgsRUFBYUYsS0FBYixJQUFzQkMsR0FBdEIsR0FBNEJGLElBQUlHLE1BQUosQ0FBV0YsUUFBTSxDQUFqQixDQUFoRDtBQUFBLENBQWxCOztBQUVBSCxPQUFPTSxzQkFBUCxHQUFnQyxVQUFTQyxZQUFULEVBQWlDOztBQUUvRCxN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LElBQXBCLENBQXlCLEtBQXpCLENBQWdDLEdBQXhFLENBQWpCO0FBQ0Q7QUFDRDJGLG9CQUFZck0sSUFBWixDQUFpQlosT0FBT00sc0JBQVAsQ0FBOEIsWUFBOUIsRUFBNENnTixjQUE1QyxFQUE0REYsa0JBQWtCLENBQWxCLENBQTVELENBQWpCO0FBQ0QsT0FYTSxNQVdBLElBQUlGLFVBQVVqTSxNQUFWLElBQW9CLENBQXhCLEVBQTJCO0FBQ2hDZ00sb0JBQVlyTSxJQUFaLENBQWlCcEIsS0FBSzRCLE1BQUwsQ0FBWSxRQUFaLEVBQXNCOEwsVUFBVSxDQUFWLENBQXRCLEVBQXFDLElBQUdBLFVBQVVHLE1BQVYsQ0FBaUIsQ0FBakIsRUFBb0IvRixJQUFwQixDQUF5QixLQUF6QixDQUFnQyxHQUF4RSxDQUFqQjtBQUNEO0FBQ0Y7QUFDRHlGLG1CQUFlRSxZQUFZM0YsSUFBWixDQUFpQixHQUFqQixDQUFmO0FBQ0Q7QUFDRCxTQUFPeUYsWUFBUDtBQUNELENBOUJEOztBQWdDQVEsT0FBT0MsT0FBUCxHQUFpQnhOLE1BQWpCIiwiZmlsZSI6InBhcnNlci5qcyIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IFByb21pc2UgPSByZXF1aXJlKCdibHVlYmlyZCcpO1xuY29uc3QgXyA9IHJlcXVpcmUoJ2xvZGFzaCcpO1xuY29uc3QgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcblxubGV0IGRzZURyaXZlcjtcbnRyeSB7XG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBpbXBvcnQvbm8tZXh0cmFuZW91cy1kZXBlbmRlbmNpZXMsIGltcG9ydC9uby11bnJlc29sdmVkXG4gIGRzZURyaXZlciA9IHJlcXVpcmUoJ2RzZS1kcml2ZXInKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZHNlRHJpdmVyID0gbnVsbDtcbn1cblxuY29uc3QgY3FsID0gUHJvbWlzZS5wcm9taXNpZnlBbGwoZHNlRHJpdmVyIHx8IHJlcXVpcmUoJ2Nhc3NhbmRyYS1kcml2ZXInKSk7XG5cbmNvbnN0IGJ1aWxkRXJyb3IgPSByZXF1aXJlKCcuLi9vcm0vYXBvbGxvX2Vycm9yLmpzJyk7XG5jb25zdCBkYXRhdHlwZXMgPSByZXF1aXJlKCcuLi92YWxpZGF0b3JzL2RhdGF0eXBlcycpO1xuY29uc3Qgc2NoZW1lciA9IHJlcXVpcmUoJy4uL3ZhbGlkYXRvcnMvc2NoZW1hJyk7XG5cbmNvbnN0IHBhcnNlciA9IHt9O1xuY29uc3Qgc2V0Q2hhckF0ID0gKHN0cixpbmRleCwgY2hyKSA9PiBzdHIuc3Vic3RyKDAsaW5kZXgpICsgY2hyICsgc3RyLnN1YnN0cihpbmRleCsxKTtcblxucGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUgPSBmdW5jdGlvbihmb3JtYXRTdHJpbmcsIC4uLnBhcmFtcyl7XG5cbiAgY29uc3QgcGxhY2Vob2xkZXJzID0gW107XG5cbiAgY29uc3QgcmUgPSAvJS4vZztcbiAgbGV0IG1hdGNoO1xuICBkbyB7XG4gICAgICBtYXRjaCA9IHJlLmV4ZWMoZm9ybWF0U3RyaW5nKTtcbiAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICAgIHBsYWNlaG9sZGVycy5wdXNoKG1hdGNoKVxuICAgICAgfVxuICB9IHdoaWxlIChtYXRjaCk7XG5cbiAgKHBhcmFtcyB8fCBbXSkuZm9yRWFjaCgocCxpKSA9PiB7XG4gICAgaWYoaSA8IHBsYWNlaG9sZGVycy5sZW5ndGggJiYgdHlwZW9mKHApID09PSBcInN0cmluZ1wiICYmIHAuaW5kZXhPZihcIi0+XCIpICE9PSAtMSl7XG4gICAgICBjb25zdCBmcCA9IHBsYWNlaG9sZGVyc1tpXTtcbiAgICAgIGlmKFxuICAgICAgICBmcC5pbmRleCA+IDAgJiZcbiAgICAgICAgZm9ybWF0U3RyaW5nLmxlbmd0aCA+IGZwLmluZGV4KzIgJiZcbiAgICAgICAgZm9ybWF0U3RyaW5nW2ZwLmluZGV4LTFdID09PSAnXCInICYmXG4gICAgICAgIGZvcm1hdFN0cmluZ1tmcC5pbmRleCsyXSA9PT0gJ1wiJ1xuICAgICAgKXtcbiAgICAgICAgZm9ybWF0U3RyaW5nID0gc2V0Q2hhckF0KGZvcm1hdFN0cmluZywgZnAuaW5kZXgtMSwgXCIgXCIpO1xuICAgICAgICBmb3JtYXRTdHJpbmcgPSBzZXRDaGFyQXQoZm9ybWF0U3RyaW5nLCBmcC5pbmRleCsyLCBcIiBcIik7XG4gICAgICB9XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4gdXRpbC5mb3JtYXQoZm9ybWF0U3RyaW5nLCAuLi5wYXJhbXMpO1xufVxuXG5wYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3cgPSBmdW5jdGlvbiBmKGVyciwgY2FsbGJhY2spIHtcbiAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrKGVycik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRocm93IChlcnIpO1xufTtcblxucGFyc2VyLmV4dHJhY3RfdHlwZSA9IGZ1bmN0aW9uIGYodmFsKSB7XG4gIC8vIGRlY29tcG9zZSBjb21wb3NpdGUgdHlwZXNcbiAgY29uc3QgZGVjb21wb3NlZCA9IHZhbCA/IHZhbC5yZXBsYWNlKC9bXFxzXS9nLCAnJykuc3BsaXQoL1s8LD5dL2cpIDogWycnXTtcblxuICBmb3IgKGxldCBkID0gMDsgZCA8IGRlY29tcG9zZWQubGVuZ3RoOyBkKyspIHtcbiAgICBpZiAoXy5oYXMoZGF0YXR5cGVzLCBkZWNvbXBvc2VkW2RdKSkge1xuICAgICAgcmV0dXJuIGRlY29tcG9zZWRbZF07XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHZhbDtcbn07XG5cbnBhcnNlci5leHRyYWN0X3R5cGVEZWYgPSBmdW5jdGlvbiBmKHZhbCkge1xuICAvLyBkZWNvbXBvc2UgY29tcG9zaXRlIHR5cGVzXG4gIGxldCBkZWNvbXBvc2VkID0gdmFsID8gdmFsLnJlcGxhY2UoL1tcXHNdL2csICcnKSA6ICcnO1xuICBkZWNvbXBvc2VkID0gZGVjb21wb3NlZC5zdWJzdHIoZGVjb21wb3NlZC5pbmRleE9mKCc8JyksIGRlY29tcG9zZWQubGVuZ3RoIC0gZGVjb21wb3NlZC5pbmRleE9mKCc8JykpO1xuXG4gIHJldHVybiBkZWNvbXBvc2VkO1xufTtcblxucGFyc2VyLmV4dHJhY3RfYWx0ZXJlZF90eXBlID0gZnVuY3Rpb24gZihub3JtYWxpemVkTW9kZWxTY2hlbWEsIGRpZmYpIHtcbiAgY29uc3QgZmllbGROYW1lID0gZGlmZi5wYXRoWzBdO1xuICBsZXQgdHlwZSA9ICcnO1xuICBpZiAoZGlmZi5wYXRoLmxlbmd0aCA+IDEpIHtcbiAgICBpZiAoZGlmZi5wYXRoWzFdID09PSAndHlwZScpIHtcbiAgICAgIHR5cGUgPSBkaWZmLnJocztcbiAgICAgIGlmIChub3JtYWxpemVkTW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZURlZikge1xuICAgICAgICB0eXBlICs9IG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlRGVmO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0eXBlID0gbm9ybWFsaXplZE1vZGVsU2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGU7XG4gICAgICB0eXBlICs9IGRpZmYucmhzO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB0eXBlID0gZGlmZi5yaHMudHlwZTtcbiAgICBpZiAoZGlmZi5yaHMudHlwZURlZikgdHlwZSArPSBkaWZmLnJocy50eXBlRGVmO1xuICB9XG4gIHJldHVybiB0eXBlO1xufTtcblxucGFyc2VyLmdldF9kYl92YWx1ZV9leHByZXNzaW9uID0gZnVuY3Rpb24gZihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSkge1xuICBpZiAoZmllbGRWYWx1ZSA9PSBudWxsIHx8IGZpZWxkVmFsdWUgPT09IGNxbC50eXBlcy51bnNldCkge1xuICAgIHJldHVybiB7IHF1ZXJ5X3NlZ21lbnQ6ICc/JywgcGFyYW1ldGVyOiBmaWVsZFZhbHVlIH07XG4gIH1cblxuICBpZiAoXy5pc1BsYWluT2JqZWN0KGZpZWxkVmFsdWUpICYmIGZpZWxkVmFsdWUuJGRiX2Z1bmN0aW9uKSB7XG4gICAgcmV0dXJuIGZpZWxkVmFsdWUuJGRiX2Z1bmN0aW9uO1xuICB9XG5cbiAgY29uc3QgZmllbGRUeXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG4gIGNvbnN0IHZhbGlkYXRvcnMgPSBzY2hlbWVyLmdldF92YWxpZGF0b3JzKHNjaGVtYSwgZmllbGROYW1lKTtcblxuICBpZiAoXy5pc0FycmF5KGZpZWxkVmFsdWUpICYmIGZpZWxkVHlwZSAhPT0gJ2xpc3QnICYmIGZpZWxkVHlwZSAhPT0gJ3NldCcgJiYgZmllbGRUeXBlICE9PSAnZnJvemVuJykge1xuICAgIGNvbnN0IHZhbCA9IGZpZWxkVmFsdWUubWFwKCh2KSA9PiB7XG4gICAgICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZSwgdik7XG5cbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHJldHVybiBkYlZhbC5wYXJhbWV0ZXI7XG4gICAgICByZXR1cm4gZGJWYWw7XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBxdWVyeV9zZWdtZW50OiAnPycsIHBhcmFtZXRlcjogdmFsIH07XG4gIH1cblxuICBjb25zdCB2YWxpZGF0aW9uTWVzc2FnZSA9IHNjaGVtZXIuZ2V0X3ZhbGlkYXRpb25fbWVzc2FnZSh2YWxpZGF0b3JzLCBmaWVsZFZhbHVlKTtcbiAgaWYgKHR5cGVvZiB2YWxpZGF0aW9uTWVzc2FnZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHZhbHVlJywgdmFsaWRhdGlvbk1lc3NhZ2UoZmllbGRWYWx1ZSwgZmllbGROYW1lLCBmaWVsZFR5cGUpKSk7XG4gIH1cblxuICBpZiAoZmllbGRUeXBlID09PSAnY291bnRlcicpIHtcbiAgICBsZXQgY291bnRlclF1ZXJ5U2VnbWVudCA9IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCInLCBmaWVsZE5hbWUpO1xuICAgIGlmIChmaWVsZFZhbHVlID49IDApIGNvdW50ZXJRdWVyeVNlZ21lbnQgKz0gJyArID8nO1xuICAgIGVsc2UgY291bnRlclF1ZXJ5U2VnbWVudCArPSAnIC0gPyc7XG4gICAgZmllbGRWYWx1ZSA9IE1hdGguYWJzKGZpZWxkVmFsdWUpO1xuICAgIHJldHVybiB7IHF1ZXJ5X3NlZ21lbnQ6IGNvdW50ZXJRdWVyeVNlZ21lbnQsIHBhcmFtZXRlcjogZmllbGRWYWx1ZSB9O1xuICB9XG5cbiAgcmV0dXJuIHsgcXVlcnlfc2VnbWVudDogJz8nLCBwYXJhbWV0ZXI6IGZpZWxkVmFsdWUgfTtcbn07XG5cbnBhcnNlci51bnNldF9ub3RfYWxsb3dlZCA9IGZ1bmN0aW9uIGYob3BlcmF0aW9uLCBzY2hlbWEsIGZpZWxkTmFtZSwgY2FsbGJhY2spIHtcbiAgaWYgKHNjaGVtZXIuaXNfcHJpbWFyeV9rZXlfZmllbGQoc2NoZW1hLCBmaWVsZE5hbWUpKSB7XG4gICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGJ1aWxkRXJyb3IoYG1vZGVsLiR7b3BlcmF0aW9ufS51bnNldGtleWAsIGZpZWxkTmFtZSksIGNhbGxiYWNrKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAoc2NoZW1lci5pc19yZXF1aXJlZF9maWVsZChzY2hlbWEsIGZpZWxkTmFtZSkpIHtcbiAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coYnVpbGRFcnJvcihgbW9kZWwuJHtvcGVyYXRpb259LnVuc2V0cmVxdWlyZWRgLCBmaWVsZE5hbWUpLCBjYWxsYmFjayk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufTtcblxucGFyc2VyLmdldF9pbnBsYWNlX3VwZGF0ZV9leHByZXNzaW9uID0gZnVuY3Rpb24gZihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSwgdXBkYXRlQ2xhdXNlcywgcXVlcnlQYXJhbXMpIHtcbiAgY29uc3QgJGFkZCA9IChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kYWRkKSB8fCBmYWxzZTtcbiAgY29uc3QgJGFwcGVuZCA9IChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kYXBwZW5kKSB8fCBmYWxzZTtcbiAgY29uc3QgJHByZXBlbmQgPSAoXy5pc1BsYWluT2JqZWN0KGZpZWxkVmFsdWUpICYmIGZpZWxkVmFsdWUuJHByZXBlbmQpIHx8IGZhbHNlO1xuICBjb25zdCAkcmVwbGFjZSA9IChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kcmVwbGFjZSkgfHwgZmFsc2U7XG4gIGNvbnN0ICRyZW1vdmUgPSAoXy5pc1BsYWluT2JqZWN0KGZpZWxkVmFsdWUpICYmIGZpZWxkVmFsdWUuJHJlbW92ZSkgfHwgZmFsc2U7XG5cbiAgZmllbGRWYWx1ZSA9ICRhZGQgfHwgJGFwcGVuZCB8fCAkcHJlcGVuZCB8fCAkcmVwbGFjZSB8fCAkcmVtb3ZlIHx8IGZpZWxkVmFsdWU7XG5cbiAgY29uc3QgZGJWYWwgPSBwYXJzZXIuZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24oc2NoZW1hLCBmaWVsZE5hbWUsIGZpZWxkVmFsdWUpO1xuXG4gIGlmICghXy5pc1BsYWluT2JqZWN0KGRiVmFsKSB8fCAhZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgIHVwZGF0ZUNsYXVzZXMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiPSVzJywgZmllbGROYW1lLCBkYlZhbCkpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGZpZWxkVHlwZSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBmaWVsZE5hbWUpO1xuXG4gIGlmIChbJ21hcCcsICdsaXN0JywgJ3NldCddLmluY2x1ZGVzKGZpZWxkVHlwZSkpIHtcbiAgICBpZiAoJGFkZCB8fCAkYXBwZW5kKSB7XG4gICAgICBkYlZhbC5xdWVyeV9zZWdtZW50ID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIiArICVzJywgZmllbGROYW1lLCBkYlZhbC5xdWVyeV9zZWdtZW50KTtcbiAgICB9IGVsc2UgaWYgKCRwcmVwZW5kKSB7XG4gICAgICBpZiAoZmllbGRUeXBlID09PSAnbGlzdCcpIHtcbiAgICAgICAgZGJWYWwucXVlcnlfc2VnbWVudCA9IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCclcyArIFwiJXNcIicsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQsIGZpZWxkTmFtZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcihcbiAgICAgICAgICAnbW9kZWwudXBkYXRlLmludmFsaWRwcmVwZW5kb3AnLFxuICAgICAgICAgIHV0aWwuZm9ybWF0KCclcyBkYXRhdHlwZXMgZG9lcyBub3Qgc3VwcG9ydCAkcHJlcGVuZCwgdXNlICRhZGQgaW5zdGVhZCcsIGZpZWxkVHlwZSksXG4gICAgICAgICkpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoJHJlbW92ZSkge1xuICAgICAgZGJWYWwucXVlcnlfc2VnbWVudCA9IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCIgLSAlcycsIGZpZWxkTmFtZSwgZGJWYWwucXVlcnlfc2VnbWVudCk7XG4gICAgICBpZiAoZmllbGRUeXBlID09PSAnbWFwJykgZGJWYWwucGFyYW1ldGVyID0gT2JqZWN0LmtleXMoZGJWYWwucGFyYW1ldGVyKTtcbiAgICB9XG4gIH1cblxuICBpZiAoJHJlcGxhY2UpIHtcbiAgICBpZiAoZmllbGRUeXBlID09PSAnbWFwJykge1xuICAgICAgdXBkYXRlQ2xhdXNlcy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCJbP109JXMnLCBmaWVsZE5hbWUsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpKTtcbiAgICAgIGNvbnN0IHJlcGxhY2VLZXlzID0gT2JqZWN0LmtleXMoZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgIGNvbnN0IHJlcGxhY2VWYWx1ZXMgPSBfLnZhbHVlcyhkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgaWYgKHJlcGxhY2VLZXlzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKHJlcGxhY2VLZXlzWzBdKTtcbiAgICAgICAgcXVlcnlQYXJhbXMucHVzaChyZXBsYWNlVmFsdWVzWzBdKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IChcbiAgICAgICAgICBidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuaW52YWxpZHJlcGxhY2VvcCcsICckcmVwbGFjZSBpbiBtYXAgZG9lcyBub3Qgc3VwcG9ydCBtb3JlIHRoYW4gb25lIGl0ZW0nKVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoZmllbGRUeXBlID09PSAnbGlzdCcpIHtcbiAgICAgIHVwZGF0ZUNsYXVzZXMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiWz9dPSVzJywgZmllbGROYW1lLCBkYlZhbC5xdWVyeV9zZWdtZW50KSk7XG4gICAgICBpZiAoZGJWYWwucGFyYW1ldGVyLmxlbmd0aCA9PT0gMikge1xuICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlclswXSk7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyWzFdKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKFxuICAgICAgICAgICdtb2RlbC51cGRhdGUuaW52YWxpZHJlcGxhY2VvcCcsXG4gICAgICAgICAgJyRyZXBsYWNlIGluIGxpc3Qgc2hvdWxkIGhhdmUgZXhhY3RseSAyIGl0ZW1zLCBmaXJzdCBvbmUgYXMgdGhlIGluZGV4IGFuZCB0aGUgc2Vjb25kIG9uZSBhcyB0aGUgdmFsdWUnLFxuICAgICAgICApKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoXG4gICAgICAgICdtb2RlbC51cGRhdGUuaW52YWxpZHJlcGxhY2VvcCcsXG4gICAgICAgIHV0aWwuZm9ybWF0KCclcyBkYXRhdHlwZXMgZG9lcyBub3Qgc3VwcG9ydCAkcmVwbGFjZScsIGZpZWxkVHlwZSksXG4gICAgICApKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgdXBkYXRlQ2xhdXNlcy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCI9JXMnLCBmaWVsZE5hbWUsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpKTtcbiAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gIH1cbn07XG5cbnBhcnNlci5nZXRfdXBkYXRlX3ZhbHVlX2V4cHJlc3Npb24gPSBmdW5jdGlvbiBmKGluc3RhbmNlLCBzY2hlbWEsIHVwZGF0ZVZhbHVlcywgY2FsbGJhY2spIHtcbiAgY29uc3QgdXBkYXRlQ2xhdXNlcyA9IFtdO1xuICBjb25zdCBxdWVyeVBhcmFtcyA9IFtdO1xuXG4gIGlmIChzY2hlbWEub3B0aW9ucyAmJiBzY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzKSB7XG4gICAgaWYgKCF1cGRhdGVWYWx1ZXNbc2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy51cGRhdGVkQXRdKSB7XG4gICAgICB1cGRhdGVWYWx1ZXNbc2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy51cGRhdGVkQXRdID0geyAkZGJfZnVuY3Rpb246ICd0b1RpbWVzdGFtcChub3coKSknIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKHNjaGVtYS5vcHRpb25zICYmIHNjaGVtYS5vcHRpb25zLnZlcnNpb25zKSB7XG4gICAgaWYgKCF1cGRhdGVWYWx1ZXNbc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5XSkge1xuICAgICAgdXBkYXRlVmFsdWVzW3NjaGVtYS5vcHRpb25zLnZlcnNpb25zLmtleV0gPSB7ICRkYl9mdW5jdGlvbjogJ25vdygpJyB9O1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGVycm9ySGFwcGVuZWQgPSBPYmplY3Qua2V5cyh1cGRhdGVWYWx1ZXMpLnNvbWUoKGZpZWxkTmFtZSkgPT4ge1xuICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gPT09IHVuZGVmaW5lZCB8fCBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udmlydHVhbCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgY29uc3QgZmllbGRUeXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG4gICAgbGV0IGZpZWxkVmFsdWUgPSB1cGRhdGVWYWx1ZXNbZmllbGROYW1lXTtcblxuICAgIGlmIChmaWVsZFZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGZpZWxkVmFsdWUgPSBpbnN0YW5jZS5fZ2V0X2RlZmF1bHRfdmFsdWUoZmllbGROYW1lKTtcbiAgICAgIGlmIChmaWVsZFZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIHBhcnNlci51bnNldF9ub3RfYWxsb3dlZCgndXBkYXRlJywgc2NoZW1hLCBmaWVsZE5hbWUsIGNhbGxiYWNrKTtcbiAgICAgIH0gZWxzZSBpZiAoIXNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5ydWxlIHx8ICFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0ucnVsZS5pZ25vcmVfZGVmYXVsdCkge1xuICAgICAgICAvLyBkaWQgc2V0IGEgZGVmYXVsdCB2YWx1ZSwgaWdub3JlIGRlZmF1bHQgaXMgbm90IHNldFxuICAgICAgICBpZiAoaW5zdGFuY2UudmFsaWRhdGUoZmllbGROYW1lLCBmaWVsZFZhbHVlKSAhPT0gdHJ1ZSkge1xuICAgICAgICAgIHBhcnNlci5jYWxsYmFja19vcl90aHJvdyhidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuaW52YWxpZGRlZmF1bHR2YWx1ZScsIGZpZWxkVmFsdWUsIGZpZWxkTmFtZSwgZmllbGRUeXBlKSwgY2FsbGJhY2spO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUgPT09IG51bGwgfHwgZmllbGRWYWx1ZSA9PT0gY3FsLnR5cGVzLnVuc2V0KSB7XG4gICAgICBpZiAocGFyc2VyLnVuc2V0X25vdF9hbGxvd2VkKCd1cGRhdGUnLCBzY2hlbWEsIGZpZWxkTmFtZSwgY2FsbGJhY2spKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBwYXJzZXIuZ2V0X2lucGxhY2VfdXBkYXRlX2V4cHJlc3Npb24oc2NoZW1hLCBmaWVsZE5hbWUsIGZpZWxkVmFsdWUsIHVwZGF0ZUNsYXVzZXMsIHF1ZXJ5UGFyYW1zKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coZSwgY2FsbGJhY2spO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSk7XG5cbiAgcmV0dXJuIHsgdXBkYXRlQ2xhdXNlcywgcXVlcnlQYXJhbXMsIGVycm9ySGFwcGVuZWQgfTtcbn07XG5cbnBhcnNlci5nZXRfc2F2ZV92YWx1ZV9leHByZXNzaW9uID0gZnVuY3Rpb24gZm4oaW5zdGFuY2UsIHNjaGVtYSwgY2FsbGJhY2spIHtcbiAgY29uc3QgaWRlbnRpZmllcnMgPSBbXTtcbiAgY29uc3QgdmFsdWVzID0gW107XG4gIGNvbnN0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgaWYgKHNjaGVtYS5vcHRpb25zICYmIHNjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMpIHtcbiAgICBpZiAoaW5zdGFuY2Vbc2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy51cGRhdGVkQXRdKSB7XG4gICAgICBpbnN0YW5jZVtzY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzLnVwZGF0ZWRBdF0gPSB7ICRkYl9mdW5jdGlvbjogJ3RvVGltZXN0YW1wKG5vdygpKScgfTtcbiAgICB9XG4gIH1cblxuICBpZiAoc2NoZW1hLm9wdGlvbnMgJiYgc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMpIHtcbiAgICBpZiAoaW5zdGFuY2Vbc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5XSkge1xuICAgICAgaW5zdGFuY2Vbc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5XSA9IHsgJGRiX2Z1bmN0aW9uOiAnbm93KCknIH07XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZXJyb3JIYXBwZW5lZCA9IE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpLnNvbWUoKGZpZWxkTmFtZSkgPT4ge1xuICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udmlydHVhbCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgLy8gY2hlY2sgZmllbGQgdmFsdWVcbiAgICBjb25zdCBmaWVsZFR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwgZmllbGROYW1lKTtcbiAgICBsZXQgZmllbGRWYWx1ZSA9IGluc3RhbmNlW2ZpZWxkTmFtZV07XG5cbiAgICBpZiAoZmllbGRWYWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBmaWVsZFZhbHVlID0gaW5zdGFuY2UuX2dldF9kZWZhdWx0X3ZhbHVlKGZpZWxkTmFtZSk7XG4gICAgICBpZiAoZmllbGRWYWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJldHVybiBwYXJzZXIudW5zZXRfbm90X2FsbG93ZWQoJ3NhdmUnLCBzY2hlbWEsIGZpZWxkTmFtZSwgY2FsbGJhY2spO1xuICAgICAgfSBlbHNlIGlmICghc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnJ1bGUgfHwgIXNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5ydWxlLmlnbm9yZV9kZWZhdWx0KSB7XG4gICAgICAgIC8vIGRpZCBzZXQgYSBkZWZhdWx0IHZhbHVlLCBpZ25vcmUgZGVmYXVsdCBpcyBub3Qgc2V0XG4gICAgICAgIGlmIChpbnN0YW5jZS52YWxpZGF0ZShmaWVsZE5hbWUsIGZpZWxkVmFsdWUpICE9PSB0cnVlKSB7XG4gICAgICAgICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuaW52YWxpZGRlZmF1bHR2YWx1ZScsIGZpZWxkVmFsdWUsIGZpZWxkTmFtZSwgZmllbGRUeXBlKSwgY2FsbGJhY2spO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUgPT09IG51bGwgfHwgZmllbGRWYWx1ZSA9PT0gY3FsLnR5cGVzLnVuc2V0KSB7XG4gICAgICBpZiAocGFyc2VyLnVuc2V0X25vdF9hbGxvd2VkKCdzYXZlJywgc2NoZW1hLCBmaWVsZE5hbWUsIGNhbGxiYWNrKSkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZGVudGlmaWVycy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCInLCBmaWVsZE5hbWUpKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGRiVmFsKSAmJiBkYlZhbC5xdWVyeV9zZWdtZW50KSB7XG4gICAgICAgIHZhbHVlcy5wdXNoKGRiVmFsLnF1ZXJ5X3NlZ21lbnQpO1xuICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YWx1ZXMucHVzaChkYlZhbCk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGUsIGNhbGxiYWNrKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH0pO1xuXG4gIHJldHVybiB7XG4gICAgaWRlbnRpZmllcnMsXG4gICAgdmFsdWVzLFxuICAgIHF1ZXJ5UGFyYW1zLFxuICAgIGVycm9ySGFwcGVuZWQsXG4gIH07XG59O1xuXG5wYXJzZXIuZXh0cmFjdF9xdWVyeV9yZWxhdGlvbnMgPSBmdW5jdGlvbiBmKGZpZWxkTmFtZSwgcmVsYXRpb25LZXksIHJlbGF0aW9uVmFsdWUsIHNjaGVtYSwgdmFsaWRPcGVyYXRvcnMpIHtcbiAgY29uc3QgcXVlcnlSZWxhdGlvbnMgPSBbXTtcbiAgY29uc3QgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBpZiAoIV8uaGFzKHZhbGlkT3BlcmF0b3JzLCByZWxhdGlvbktleS50b0xvd2VyQ2FzZSgpKSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRvcCcsIHJlbGF0aW9uS2V5KSk7XG4gIH1cblxuICByZWxhdGlvbktleSA9IHJlbGF0aW9uS2V5LnRvTG93ZXJDYXNlKCk7XG4gIGlmIChyZWxhdGlvbktleSA9PT0gJyRpbicgJiYgIV8uaXNBcnJheShyZWxhdGlvblZhbHVlKSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRpbm9wJykpO1xuICB9XG4gIGlmIChyZWxhdGlvbktleSA9PT0gJyR0b2tlbicgJiYgIShyZWxhdGlvblZhbHVlIGluc3RhbmNlb2YgT2JqZWN0KSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWR0b2tlbicpKTtcbiAgfVxuXG4gIGxldCBvcGVyYXRvciA9IHZhbGlkT3BlcmF0b3JzW3JlbGF0aW9uS2V5XTtcbiAgbGV0IHdoZXJlVGVtcGxhdGUgPSAnXCIlc1wiICVzICVzJztcblxuICBjb25zdCBidWlsZFF1ZXJ5UmVsYXRpb25zID0gKGZpZWxkTmFtZUxvY2FsLCByZWxhdGlvblZhbHVlTG9jYWwpID0+IHtcbiAgICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZUxvY2FsLCByZWxhdGlvblZhbHVlTG9jYWwpO1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHtcbiAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoXG4gICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgIGZpZWxkTmFtZUxvY2FsLCBvcGVyYXRvciwgZGJWYWwucXVlcnlfc2VnbWVudCxcbiAgICAgICkpO1xuICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKFxuICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICBmaWVsZE5hbWVMb2NhbCwgb3BlcmF0b3IsIGRiVmFsLFxuICAgICAgKSk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGJ1aWxkVG9rZW5RdWVyeVJlbGF0aW9ucyA9ICh0b2tlblJlbGF0aW9uS2V5LCB0b2tlblJlbGF0aW9uVmFsdWUpID0+IHtcbiAgICB0b2tlblJlbGF0aW9uS2V5ID0gdG9rZW5SZWxhdGlvbktleS50b0xvd2VyQ2FzZSgpO1xuICAgIGlmIChfLmhhcyh2YWxpZE9wZXJhdG9ycywgdG9rZW5SZWxhdGlvbktleSkgJiYgdG9rZW5SZWxhdGlvbktleSAhPT0gJyR0b2tlbicgJiYgdG9rZW5SZWxhdGlvbktleSAhPT0gJyRpbicpIHtcbiAgICAgIG9wZXJhdG9yID0gdmFsaWRPcGVyYXRvcnNbdG9rZW5SZWxhdGlvbktleV07XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWR0b2tlbm9wJywgdG9rZW5SZWxhdGlvbktleSkpO1xuICAgIH1cblxuICAgIGlmIChfLmlzQXJyYXkodG9rZW5SZWxhdGlvblZhbHVlKSkge1xuICAgICAgY29uc3QgdG9rZW5LZXlzID0gZmllbGROYW1lLnNwbGl0KCcsJyk7XG4gICAgICBmb3IgKGxldCB0b2tlbkluZGV4ID0gMDsgdG9rZW5JbmRleCA8IHRva2VuUmVsYXRpb25WYWx1ZS5sZW5ndGg7IHRva2VuSW5kZXgrKykge1xuICAgICAgICB0b2tlbktleXNbdG9rZW5JbmRleF0gPSB0b2tlbktleXNbdG9rZW5JbmRleF0udHJpbSgpO1xuICAgICAgICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIHRva2VuS2V5c1t0b2tlbkluZGV4XSwgdG9rZW5SZWxhdGlvblZhbHVlW3Rva2VuSW5kZXhdKTtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgICAgICAgIHRva2VuUmVsYXRpb25WYWx1ZVt0b2tlbkluZGV4XSA9IGRiVmFsLnF1ZXJ5X3NlZ21lbnQ7XG4gICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRva2VuUmVsYXRpb25WYWx1ZVt0b2tlbkluZGV4XSA9IGRiVmFsO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICB0b2tlbktleXMuam9pbignXCIsXCInKSwgb3BlcmF0b3IsIHRva2VuUmVsYXRpb25WYWx1ZS50b1N0cmluZygpLFxuICAgICAgKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGJ1aWxkUXVlcnlSZWxhdGlvbnMoZmllbGROYW1lLCB0b2tlblJlbGF0aW9uVmFsdWUpO1xuICAgIH1cbiAgfTtcblxuICBpZiAocmVsYXRpb25LZXkgPT09ICckdG9rZW4nKSB7XG4gICAgd2hlcmVUZW1wbGF0ZSA9ICd0b2tlbihcIiVzXCIpICVzIHRva2VuKCVzKSc7XG5cbiAgICBjb25zdCB0b2tlblJlbGF0aW9uS2V5cyA9IE9iamVjdC5rZXlzKHJlbGF0aW9uVmFsdWUpO1xuICAgIGZvciAobGV0IHRva2VuUksgPSAwOyB0b2tlblJLIDwgdG9rZW5SZWxhdGlvbktleXMubGVuZ3RoOyB0b2tlblJLKyspIHtcbiAgICAgIGNvbnN0IHRva2VuUmVsYXRpb25LZXkgPSB0b2tlblJlbGF0aW9uS2V5c1t0b2tlblJLXTtcbiAgICAgIGNvbnN0IHRva2VuUmVsYXRpb25WYWx1ZSA9IHJlbGF0aW9uVmFsdWVbdG9rZW5SZWxhdGlvbktleV07XG4gICAgICBidWlsZFRva2VuUXVlcnlSZWxhdGlvbnModG9rZW5SZWxhdGlvbktleSwgdG9rZW5SZWxhdGlvblZhbHVlKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAocmVsYXRpb25LZXkgPT09ICckY29udGFpbnMnKSB7XG4gICAgY29uc3QgZmllbGRUeXBlMSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBmaWVsZE5hbWUpO1xuICAgIGlmIChbJ21hcCcsICdsaXN0JywgJ3NldCcsICdmcm96ZW4nXS5pbmNsdWRlcyhmaWVsZFR5cGUxKSkge1xuICAgICAgaWYgKGZpZWxkVHlwZTEgPT09ICdtYXAnICYmIF8uaXNQbGFpbk9iamVjdChyZWxhdGlvblZhbHVlKSkge1xuICAgICAgICBPYmplY3Qua2V5cyhyZWxhdGlvblZhbHVlKS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKFxuICAgICAgICAgICAgJ1wiJXNcIlslc10gJXMgJXMnLFxuICAgICAgICAgICAgZmllbGROYW1lLCAnPycsICc9JywgJz8nLFxuICAgICAgICAgICkpO1xuICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goa2V5KTtcbiAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKHJlbGF0aW9uVmFsdWVba2V5XSk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZShcbiAgICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICAgIGZpZWxkTmFtZSwgb3BlcmF0b3IsICc/JyxcbiAgICAgICAgKSk7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2gocmVsYXRpb25WYWx1ZSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRjb250YWluc29wJykpO1xuICAgIH1cbiAgfSBlbHNlIGlmIChyZWxhdGlvbktleSA9PT0gJyRjb250YWluc19rZXknKSB7XG4gICAgY29uc3QgZmllbGRUeXBlMiA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBmaWVsZE5hbWUpO1xuICAgIGlmIChmaWVsZFR5cGUyICE9PSAnbWFwJykge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZGNvbnRhaW5za2V5b3AnKSk7XG4gICAgfVxuICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgZmllbGROYW1lLCBvcGVyYXRvciwgJz8nLFxuICAgICkpO1xuICAgIHF1ZXJ5UGFyYW1zLnB1c2gocmVsYXRpb25WYWx1ZSk7XG4gIH0gZWxzZSB7XG4gICAgYnVpbGRRdWVyeVJlbGF0aW9ucyhmaWVsZE5hbWUsIHJlbGF0aW9uVmFsdWUpO1xuICB9XG4gIHJldHVybiB7IHF1ZXJ5UmVsYXRpb25zLCBxdWVyeVBhcmFtcyB9O1xufTtcblxucGFyc2VyLl9wYXJzZV9xdWVyeV9vYmplY3QgPSBmdW5jdGlvbiBmKHNjaGVtYSwgcXVlcnlPYmplY3QpIHtcbiAgbGV0IHF1ZXJ5UmVsYXRpb25zID0gW107XG4gIGxldCBxdWVyeVBhcmFtcyA9IFtdO1xuXG4gIE9iamVjdC5rZXlzKHF1ZXJ5T2JqZWN0KS5mb3JFYWNoKChmaWVsZE5hbWUpID0+IHtcbiAgICBpZiAoZmllbGROYW1lLnN0YXJ0c1dpdGgoJyQnKSkge1xuICAgICAgLy8gc2VhcmNoIHF1ZXJpZXMgYmFzZWQgb24gbHVjZW5lIGluZGV4IG9yIHNvbHJcbiAgICAgIC8vIGVzY2FwZSBhbGwgc2luZ2xlIHF1b3RlcyBmb3IgcXVlcmllcyBpbiBjYXNzYW5kcmFcbiAgICAgIGlmIChmaWVsZE5hbWUgPT09ICckZXhwcicpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBxdWVyeU9iamVjdFtmaWVsZE5hbWVdLmluZGV4ID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgcXVlcnlPYmplY3RbZmllbGROYW1lXS5xdWVyeSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgXCJleHByKCVzLCclcycpXCIsXG4gICAgICAgICAgICBxdWVyeU9iamVjdFtmaWVsZE5hbWVdLmluZGV4LCBxdWVyeU9iamVjdFtmaWVsZE5hbWVdLnF1ZXJ5LnJlcGxhY2UoLycvZywgXCInJ1wiKSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkZXhwcicpKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChmaWVsZE5hbWUgPT09ICckc29scl9xdWVyeScpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBxdWVyeU9iamVjdFtmaWVsZE5hbWVdID09PSAnc3RyaW5nJykge1xuICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgICAgICBcInNvbHJfcXVlcnk9JyVzJ1wiLFxuICAgICAgICAgICAgcXVlcnlPYmplY3RbZmllbGROYW1lXS5yZXBsYWNlKC8nL2csIFwiJydcIiksXG4gICAgICAgICAgKSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZHNvbHJxdWVyeScpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxldCB3aGVyZU9iamVjdCA9IHF1ZXJ5T2JqZWN0W2ZpZWxkTmFtZV07XG4gICAgLy8gQXJyYXkgb2Ygb3BlcmF0b3JzXG4gICAgaWYgKCFfLmlzQXJyYXkod2hlcmVPYmplY3QpKSB3aGVyZU9iamVjdCA9IFt3aGVyZU9iamVjdF07XG5cbiAgICBmb3IgKGxldCBmayA9IDA7IGZrIDwgd2hlcmVPYmplY3QubGVuZ3RoOyBmaysrKSB7XG4gICAgICBsZXQgZmllbGRSZWxhdGlvbiA9IHdoZXJlT2JqZWN0W2ZrXTtcblxuICAgICAgY29uc3QgY3FsT3BlcmF0b3JzID0ge1xuICAgICAgICAkZXE6ICc9JyxcbiAgICAgICAgJG5lOiAnIT0nLFxuICAgICAgICAkaXNudDogJ0lTIE5PVCcsXG4gICAgICAgICRndDogJz4nLFxuICAgICAgICAkbHQ6ICc8JyxcbiAgICAgICAgJGd0ZTogJz49JyxcbiAgICAgICAgJGx0ZTogJzw9JyxcbiAgICAgICAgJGluOiAnSU4nLFxuICAgICAgICAkbGlrZTogJ0xJS0UnLFxuICAgICAgICAkdG9rZW46ICd0b2tlbicsXG4gICAgICAgICRjb250YWluczogJ0NPTlRBSU5TJyxcbiAgICAgICAgJGNvbnRhaW5zX2tleTogJ0NPTlRBSU5TIEtFWScsXG4gICAgICB9O1xuXG4gICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGZpZWxkUmVsYXRpb24pKSB7XG4gICAgICAgIGNvbnN0IHZhbGlkS2V5cyA9IE9iamVjdC5rZXlzKGNxbE9wZXJhdG9ycyk7XG4gICAgICAgIGNvbnN0IGZpZWxkUmVsYXRpb25LZXlzID0gT2JqZWN0LmtleXMoZmllbGRSZWxhdGlvbik7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZmllbGRSZWxhdGlvbktleXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICBpZiAoIXZhbGlkS2V5cy5pbmNsdWRlcyhmaWVsZFJlbGF0aW9uS2V5c1tpXSkpIHtcbiAgICAgICAgICAgIC8vIGZpZWxkIHJlbGF0aW9uIGtleSBpbnZhbGlkLCBhcHBseSBkZWZhdWx0ICRlcSBvcGVyYXRvclxuICAgICAgICAgICAgZmllbGRSZWxhdGlvbiA9IHsgJGVxOiBmaWVsZFJlbGF0aW9uIH07XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZpZWxkUmVsYXRpb24gPSB7ICRlcTogZmllbGRSZWxhdGlvbiB9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCByZWxhdGlvbktleXMgPSBPYmplY3Qua2V5cyhmaWVsZFJlbGF0aW9uKTtcbiAgICAgIGZvciAobGV0IHJrID0gMDsgcmsgPCByZWxhdGlvbktleXMubGVuZ3RoOyByaysrKSB7XG4gICAgICAgIGNvbnN0IHJlbGF0aW9uS2V5ID0gcmVsYXRpb25LZXlzW3JrXTtcbiAgICAgICAgY29uc3QgcmVsYXRpb25WYWx1ZSA9IGZpZWxkUmVsYXRpb25bcmVsYXRpb25LZXldO1xuICAgICAgICBjb25zdCBleHRyYWN0ZWRSZWxhdGlvbnMgPSBwYXJzZXIuZXh0cmFjdF9xdWVyeV9yZWxhdGlvbnMoXG4gICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgIHJlbGF0aW9uS2V5LFxuICAgICAgICAgIHJlbGF0aW9uVmFsdWUsXG4gICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgIGNxbE9wZXJhdG9ycyxcbiAgICAgICAgKTtcbiAgICAgICAgcXVlcnlSZWxhdGlvbnMgPSBxdWVyeVJlbGF0aW9ucy5jb25jYXQoZXh0cmFjdGVkUmVsYXRpb25zLnF1ZXJ5UmVsYXRpb25zKTtcbiAgICAgICAgcXVlcnlQYXJhbXMgPSBxdWVyeVBhcmFtcy5jb25jYXQoZXh0cmFjdGVkUmVsYXRpb25zLnF1ZXJ5UGFyYW1zKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiB7IHF1ZXJ5UmVsYXRpb25zLCBxdWVyeVBhcmFtcyB9O1xufTtcblxucGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlID0gZnVuY3Rpb24gZihzY2hlbWEsIHF1ZXJ5T2JqZWN0LCBjbGF1c2UpIHtcbiAgY29uc3QgcGFyc2VkT2JqZWN0ID0gcGFyc2VyLl9wYXJzZV9xdWVyeV9vYmplY3Qoc2NoZW1hLCBxdWVyeU9iamVjdCk7XG4gIGNvbnN0IGZpbHRlckNsYXVzZSA9IHt9O1xuICBpZiAocGFyc2VkT2JqZWN0LnF1ZXJ5UmVsYXRpb25zLmxlbmd0aCA+IDApIHtcbiAgICBmaWx0ZXJDbGF1c2UucXVlcnkgPSB1dGlsLmZvcm1hdCgnJXMgJXMnLCBjbGF1c2UsIHBhcnNlZE9iamVjdC5xdWVyeVJlbGF0aW9ucy5qb2luKCcgQU5EICcpKTtcbiAgfSBlbHNlIHtcbiAgICBmaWx0ZXJDbGF1c2UucXVlcnkgPSAnJztcbiAgfVxuICBmaWx0ZXJDbGF1c2UucGFyYW1zID0gcGFyc2VkT2JqZWN0LnF1ZXJ5UGFyYW1zO1xuICByZXR1cm4gZmlsdGVyQ2xhdXNlO1xufTtcblxucGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlX2RkbCA9IGZ1bmN0aW9uIGYoc2NoZW1hLCBxdWVyeU9iamVjdCwgY2xhdXNlKSB7XG4gIGNvbnN0IGZpbHRlckNsYXVzZSA9IHBhcnNlci5nZXRfZmlsdGVyX2NsYXVzZShzY2hlbWEsIHF1ZXJ5T2JqZWN0LCBjbGF1c2UpO1xuICBsZXQgZmlsdGVyUXVlcnkgPSBmaWx0ZXJDbGF1c2UucXVlcnk7XG4gIGZpbHRlckNsYXVzZS5wYXJhbXMuZm9yRWFjaCgocGFyYW0pID0+IHtcbiAgICBsZXQgcXVlcnlQYXJhbTtcbiAgICBpZiAodHlwZW9mIHBhcmFtID09PSAnc3RyaW5nJykge1xuICAgICAgcXVlcnlQYXJhbSA9IHV0aWwuZm9ybWF0KFwiJyVzJ1wiLCBwYXJhbSk7XG4gICAgfSBlbHNlIGlmIChwYXJhbSBpbnN0YW5jZW9mIERhdGUpIHtcbiAgICAgIHF1ZXJ5UGFyYW0gPSB1dGlsLmZvcm1hdChcIiclcydcIiwgcGFyYW0udG9JU09TdHJpbmcoKSk7XG4gICAgfSBlbHNlIGlmIChwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5Mb25nXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5JbnRlZ2VyXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5CaWdEZWNpbWFsXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5UaW1lVXVpZFxuICAgICAgfHwgcGFyYW0gaW5zdGFuY2VvZiBjcWwudHlwZXMuVXVpZCkge1xuICAgICAgcXVlcnlQYXJhbSA9IHBhcmFtLnRvU3RyaW5nKCk7XG4gICAgfSBlbHNlIGlmIChwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5Mb2NhbERhdGVcbiAgICAgIHx8IHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLkxvY2FsVGltZVxuICAgICAgfHwgcGFyYW0gaW5zdGFuY2VvZiBjcWwudHlwZXMuSW5ldEFkZHJlc3MpIHtcbiAgICAgIHF1ZXJ5UGFyYW0gPSB1dGlsLmZvcm1hdChcIiclcydcIiwgcGFyYW0udG9TdHJpbmcoKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHF1ZXJ5UGFyYW0gPSBwYXJhbTtcbiAgICB9XG4gICAgLy8gVE9ETzogdW5oYW5kbGVkIGlmIHF1ZXJ5UGFyYW0gaXMgYSBzdHJpbmcgY29udGFpbmluZyA/IGNoYXJhY3RlclxuICAgIC8vIHRob3VnaCB0aGlzIGlzIHVubGlrZWx5IHRvIGhhdmUgaW4gbWF0ZXJpYWxpemVkIHZpZXcgZmlsdGVycywgYnV0Li4uXG4gICAgZmlsdGVyUXVlcnkgPSBmaWx0ZXJRdWVyeS5yZXBsYWNlKCc/JywgcXVlcnlQYXJhbSk7XG4gIH0pO1xuICByZXR1cm4gZmlsdGVyUXVlcnk7XG59O1xuXG5wYXJzZXIuZ2V0X3doZXJlX2NsYXVzZSA9IGZ1bmN0aW9uIGYoc2NoZW1hLCBxdWVyeU9iamVjdCkge1xuICByZXR1cm4gcGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlKHNjaGVtYSwgcXVlcnlPYmplY3QsICdXSEVSRScpO1xufTtcblxucGFyc2VyLmdldF9pZl9jbGF1c2UgPSBmdW5jdGlvbiBmKHNjaGVtYSwgcXVlcnlPYmplY3QpIHtcbiAgcmV0dXJuIHBhcnNlci5nZXRfZmlsdGVyX2NsYXVzZShzY2hlbWEsIHF1ZXJ5T2JqZWN0LCAnSUYnKTtcbn07XG5cbnBhcnNlci5nZXRfcHJpbWFyeV9rZXlfY2xhdXNlcyA9IGZ1bmN0aW9uIGYoc2NoZW1hKSB7XG4gIGNvbnN0IHBhcnRpdGlvbktleSA9IHNjaGVtYS5rZXlbMF07XG4gIGxldCBjbHVzdGVyaW5nS2V5ID0gc2NoZW1hLmtleS5zbGljZSgxLCBzY2hlbWEua2V5Lmxlbmd0aCk7XG4gIGNvbnN0IGNsdXN0ZXJpbmdPcmRlciA9IFtdO1xuXG4gIGZvciAobGV0IGZpZWxkID0gMDsgZmllbGQgPCBjbHVzdGVyaW5nS2V5Lmxlbmd0aDsgZmllbGQrKykge1xuICAgIGlmIChzY2hlbWEuY2x1c3RlcmluZ19vcmRlclxuICAgICAgICAmJiBzY2hlbWEuY2x1c3RlcmluZ19vcmRlcltjbHVzdGVyaW5nS2V5W2ZpZWxkXV1cbiAgICAgICAgJiYgc2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbY2x1c3RlcmluZ0tleVtmaWVsZF1dLnRvTG93ZXJDYXNlKCkgPT09ICdkZXNjJykge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIiBERVNDJywgY2x1c3RlcmluZ0tleVtmaWVsZF0pKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIiBBU0MnLCBjbHVzdGVyaW5nS2V5W2ZpZWxkXSkpO1xuICAgIH1cbiAgfVxuXG4gIGxldCBjbHVzdGVyaW5nT3JkZXJDbGF1c2UgPSAnJztcbiAgaWYgKGNsdXN0ZXJpbmdPcmRlci5sZW5ndGggPiAwKSB7XG4gICAgY2x1c3RlcmluZ09yZGVyQ2xhdXNlID0gdXRpbC5mb3JtYXQoJyBXSVRIIENMVVNURVJJTkcgT1JERVIgQlkgKCVzKScsIGNsdXN0ZXJpbmdPcmRlci50b1N0cmluZygpKTtcbiAgfVxuXG4gIGxldCBwYXJ0aXRpb25LZXlDbGF1c2UgPSAnJztcbiAgaWYgKF8uaXNBcnJheShwYXJ0aXRpb25LZXkpKSB7XG4gICAgcGFydGl0aW9uS2V5Q2xhdXNlID0gcGFydGl0aW9uS2V5Lm1hcCgodikgPT4gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHYpKS5qb2luKCcsJyk7XG4gIH0gZWxzZSB7XG4gICAgcGFydGl0aW9uS2V5Q2xhdXNlID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHBhcnRpdGlvbktleSk7XG4gIH1cblxuICBsZXQgY2x1c3RlcmluZ0tleUNsYXVzZSA9ICcnO1xuICBpZiAoY2x1c3RlcmluZ0tleS5sZW5ndGgpIHtcbiAgICBjbHVzdGVyaW5nS2V5ID0gY2x1c3RlcmluZ0tleS5tYXAoKHYpID0+IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCInLCB2KSkuam9pbignLCcpO1xuICAgIGNsdXN0ZXJpbmdLZXlDbGF1c2UgPSB1dGlsLmZvcm1hdCgnLCVzJywgY2x1c3RlcmluZ0tleSk7XG4gIH1cblxuICByZXR1cm4geyBwYXJ0aXRpb25LZXlDbGF1c2UsIGNsdXN0ZXJpbmdLZXlDbGF1c2UsIGNsdXN0ZXJpbmdPcmRlckNsYXVzZSB9O1xufTtcblxucGFyc2VyLmdldF9tdmlld193aGVyZV9jbGF1c2UgPSBmdW5jdGlvbiBmKHNjaGVtYSwgdmlld1NjaGVtYSkge1xuICBjb25zdCBjbGF1c2VzID0gcGFyc2VyLmdldF9wcmltYXJ5X2tleV9jbGF1c2VzKHZpZXdTY2hlbWEpO1xuICBsZXQgd2hlcmVDbGF1c2UgPSBjbGF1c2VzLnBhcnRpdGlvbktleUNsYXVzZS5zcGxpdCgnLCcpLmpvaW4oJyBJUyBOT1QgTlVMTCBBTkQgJyk7XG4gIGlmIChjbGF1c2VzLmNsdXN0ZXJpbmdLZXlDbGF1c2UpIHdoZXJlQ2xhdXNlICs9IGNsYXVzZXMuY2x1c3RlcmluZ0tleUNsYXVzZS5zcGxpdCgnLCcpLmpvaW4oJyBJUyBOT1QgTlVMTCBBTkQgJyk7XG4gIHdoZXJlQ2xhdXNlICs9ICcgSVMgTk9UIE5VTEwnO1xuXG4gIGNvbnN0IGZpbHRlcnMgPSBfLmNsb25lRGVlcCh2aWV3U2NoZW1hLmZpbHRlcnMpO1xuXG4gIGlmIChfLmlzUGxhaW5PYmplY3QoZmlsdGVycykpIHtcbiAgICAvLyBkZWxldGUgcHJpbWFyeSBrZXkgZmllbGRzIGRlZmluZWQgYXMgaXNuJ3QgbnVsbCBpbiBmaWx0ZXJzXG4gICAgT2JqZWN0LmtleXMoZmlsdGVycykuZm9yRWFjaCgoZmlsdGVyS2V5KSA9PiB7XG4gICAgICBpZiAoZmlsdGVyc1tmaWx0ZXJLZXldLiRpc250ID09PSBudWxsXG4gICAgICAgICAgJiYgKHZpZXdTY2hlbWEua2V5LmluY2x1ZGVzKGZpbHRlcktleSkgfHwgdmlld1NjaGVtYS5rZXlbMF0uaW5jbHVkZXMoZmlsdGVyS2V5KSkpIHtcbiAgICAgICAgZGVsZXRlIGZpbHRlcnNbZmlsdGVyS2V5XS4kaXNudDtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGNvbnN0IGZpbHRlckNsYXVzZSA9IHBhcnNlci5nZXRfZmlsdGVyX2NsYXVzZV9kZGwoc2NoZW1hLCBmaWx0ZXJzLCAnQU5EJyk7XG4gICAgd2hlcmVDbGF1c2UgKz0gdXRpbC5mb3JtYXQoJyAlcycsIGZpbHRlckNsYXVzZSkucmVwbGFjZSgvSVMgTk9UIG51bGwvZywgJ0lTIE5PVCBOVUxMJyk7XG4gIH1cblxuICAvLyByZW1vdmUgdW5uZWNlc3NhcmlseSBxdW90ZWQgZmllbGQgbmFtZXMgaW4gZ2VuZXJhdGVkIHdoZXJlIGNsYXVzZVxuICAvLyBzbyB0aGF0IGl0IG1hdGNoZXMgdGhlIHdoZXJlX2NsYXVzZSBmcm9tIGRhdGFiYXNlIHNjaGVtYVxuICBjb25zdCBxdW90ZWRGaWVsZE5hbWVzID0gd2hlcmVDbGF1c2UubWF0Y2goL1wiKC4qPylcIi9nKTtcbiAgcXVvdGVkRmllbGROYW1lcy5mb3JFYWNoKChmaWVsZE5hbWUpID0+IHtcbiAgICBjb25zdCB1bnF1b3RlZEZpZWxkTmFtZSA9IGZpZWxkTmFtZS5yZXBsYWNlKC9cIi9nLCAnJyk7XG4gICAgY29uc3QgcmVzZXJ2ZWRLZXl3b3JkcyA9IFtcbiAgICAgICdBREQnLCAnQUdHUkVHQVRFJywgJ0FMTE9XJywgJ0FMVEVSJywgJ0FORCcsICdBTlknLCAnQVBQTFknLFxuICAgICAgJ0FTQycsICdBVVRIT1JJWkUnLCAnQkFUQ0gnLCAnQkVHSU4nLCAnQlknLCAnQ09MVU1ORkFNSUxZJyxcbiAgICAgICdDUkVBVEUnLCAnREVMRVRFJywgJ0RFU0MnLCAnRFJPUCcsICdFQUNIX1FVT1JVTScsICdFTlRSSUVTJyxcbiAgICAgICdGUk9NJywgJ0ZVTEwnLCAnR1JBTlQnLCAnSUYnLCAnSU4nLCAnSU5ERVgnLCAnSU5FVCcsICdJTkZJTklUWScsXG4gICAgICAnSU5TRVJUJywgJ0lOVE8nLCAnS0VZU1BBQ0UnLCAnS0VZU1BBQ0VTJywgJ0xJTUlUJywgJ0xPQ0FMX09ORScsXG4gICAgICAnTE9DQUxfUVVPUlVNJywgJ01BVEVSSUFMSVpFRCcsICdNT0RJRlknLCAnTkFOJywgJ05PUkVDVVJTSVZFJyxcbiAgICAgICdOT1QnLCAnT0YnLCAnT04nLCAnT05FJywgJ09SREVSJywgJ1BBUlRJVElPTicsICdQQVNTV09SRCcsICdQRVInLFxuICAgICAgJ1BSSU1BUlknLCAnUVVPUlVNJywgJ1JFTkFNRScsICdSRVZPS0UnLCAnU0NIRU1BJywgJ1NFTEVDVCcsICdTRVQnLFxuICAgICAgJ1RBQkxFJywgJ1RJTUUnLCAnVEhSRUUnLCAnVE8nLCAnVE9LRU4nLCAnVFJVTkNBVEUnLCAnVFdPJywgJ1VOTE9HR0VEJyxcbiAgICAgICdVUERBVEUnLCAnVVNFJywgJ1VTSU5HJywgJ1ZJRVcnLCAnV0hFUkUnLCAnV0lUSCddO1xuICAgIGlmICh1bnF1b3RlZEZpZWxkTmFtZSA9PT0gdW5xdW90ZWRGaWVsZE5hbWUudG9Mb3dlckNhc2UoKVxuICAgICAgJiYgIXJlc2VydmVkS2V5d29yZHMuaW5jbHVkZXModW5xdW90ZWRGaWVsZE5hbWUudG9VcHBlckNhc2UoKSkpIHtcbiAgICAgIHdoZXJlQ2xhdXNlID0gd2hlcmVDbGF1c2UucmVwbGFjZShmaWVsZE5hbWUsIHVucXVvdGVkRmllbGROYW1lKTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gd2hlcmVDbGF1c2U7XG59O1xuXG5wYXJzZXIuZ2V0X29yZGVyYnlfY2xhdXNlID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCkge1xuICBjb25zdCBvcmRlcktleXMgPSBbXTtcbiAgT2JqZWN0LmtleXMocXVlcnlPYmplY3QpLmZvckVhY2goKGspID0+IHtcbiAgICBjb25zdCBxdWVyeUl0ZW0gPSBxdWVyeU9iamVjdFtrXTtcbiAgICBpZiAoay50b0xvd2VyQ2FzZSgpID09PSAnJG9yZGVyYnknKSB7XG4gICAgICBpZiAoIShxdWVyeUl0ZW0gaW5zdGFuY2VvZiBPYmplY3QpKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRvcmRlcicpKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG9yZGVySXRlbUtleXMgPSBPYmplY3Qua2V5cyhxdWVyeUl0ZW0pO1xuXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG9yZGVySXRlbUtleXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY29uc3QgY3FsT3JkZXJEaXJlY3Rpb24gPSB7ICRhc2M6ICdBU0MnLCAkZGVzYzogJ0RFU0MnIH07XG4gICAgICAgIGlmIChvcmRlckl0ZW1LZXlzW2ldLnRvTG93ZXJDYXNlKCkgaW4gY3FsT3JkZXJEaXJlY3Rpb24pIHtcbiAgICAgICAgICBsZXQgb3JkZXJGaWVsZHMgPSBxdWVyeUl0ZW1bb3JkZXJJdGVtS2V5c1tpXV07XG5cbiAgICAgICAgICBpZiAoIV8uaXNBcnJheShvcmRlckZpZWxkcykpIHtcbiAgICAgICAgICAgIG9yZGVyRmllbGRzID0gW29yZGVyRmllbGRzXTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBmb3IgKGxldCBqID0gMDsgaiA8IG9yZGVyRmllbGRzLmxlbmd0aDsgaisrKSB7XG4gICAgICAgICAgICBvcmRlcktleXMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZShcbiAgICAgICAgICAgICAgJ1wiJXNcIiAlcycsXG4gICAgICAgICAgICAgIG9yZGVyRmllbGRzW2pdLCBjcWxPcmRlckRpcmVjdGlvbltvcmRlckl0ZW1LZXlzW2ldXSxcbiAgICAgICAgICAgICkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkb3JkZXJ0eXBlJywgb3JkZXJJdGVtS2V5c1tpXSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIG9yZGVyS2V5cy5sZW5ndGggPyB1dGlsLmZvcm1hdCgnT1JERVIgQlkgJXMnLCBvcmRlcktleXMuam9pbignLCAnKSkgOiAnICc7XG59O1xuXG5wYXJzZXIuZ2V0X2dyb3VwYnlfY2xhdXNlID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCkge1xuICBsZXQgZ3JvdXBieUtleXMgPSBbXTtcblxuICBPYmplY3Qua2V5cyhxdWVyeU9iamVjdCkuZm9yRWFjaCgoaykgPT4ge1xuICAgIGNvbnN0IHF1ZXJ5SXRlbSA9IHF1ZXJ5T2JqZWN0W2tdO1xuXG4gICAgaWYgKGsudG9Mb3dlckNhc2UoKSA9PT0gJyRncm91cGJ5Jykge1xuICAgICAgaWYgKCEocXVlcnlJdGVtIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRncm91cCcpKTtcbiAgICAgIH1cblxuICAgICAgZ3JvdXBieUtleXMgPSBncm91cGJ5S2V5cy5jb25jYXQocXVlcnlJdGVtKTtcbiAgICB9XG4gIH0pO1xuXG4gIGdyb3VwYnlLZXlzID0gZ3JvdXBieUtleXMubWFwKChrZXkpID0+IGBcIiR7a2V5fVwiYCk7XG5cbiAgcmV0dXJuIGdyb3VwYnlLZXlzLmxlbmd0aCA/IHV0aWwuZm9ybWF0KCdHUk9VUCBCWSAlcycsIGdyb3VwYnlLZXlzLmpvaW4oJywgJykpIDogJyAnO1xufTtcblxucGFyc2VyLmdldF9saW1pdF9jbGF1c2UgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0KSB7XG4gIGxldCBsaW1pdCA9IG51bGw7XG4gIE9iamVjdC5rZXlzKHF1ZXJ5T2JqZWN0KS5mb3JFYWNoKChrKSA9PiB7XG4gICAgY29uc3QgcXVlcnlJdGVtID0gcXVlcnlPYmplY3Rba107XG4gICAgaWYgKGsudG9Mb3dlckNhc2UoKSA9PT0gJyRsaW1pdCcpIHtcbiAgICAgIGlmICh0eXBlb2YgcXVlcnlJdGVtICE9PSAnbnVtYmVyJykgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQubGltaXR0eXBlJykpO1xuICAgICAgbGltaXQgPSBxdWVyeUl0ZW07XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIGxpbWl0ID8gdXRpbC5mb3JtYXQoJ0xJTUlUICVzJywgbGltaXQpIDogJyAnO1xufTtcblxucGFyc2VyLmdldF9zZWxlY3RfY2xhdXNlID0gZnVuY3Rpb24gZihvcHRpb25zKSB7XG4gIGxldCBzZWxlY3RDbGF1c2UgPSAnKic7XG4gIGlmIChvcHRpb25zLnNlbGVjdCAmJiBfLmlzQXJyYXkob3B0aW9ucy5zZWxlY3QpICYmIG9wdGlvbnMuc2VsZWN0Lmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBzZWxlY3RBcnJheSA9IFtdO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgb3B0aW9ucy5zZWxlY3QubGVuZ3RoOyBpKyspIHtcbiAgICAgIC8vIHNlcGFyYXRlIHRoZSBhZ2dyZWdhdGUgZnVuY3Rpb24gYW5kIHRoZSBjb2x1bW4gbmFtZSBpZiBzZWxlY3QgaXMgYW4gYWdncmVnYXRlIGZ1bmN0aW9uXG4gICAgICBjb25zdCBzZWxlY3Rpb24gPSBvcHRpb25zLnNlbGVjdFtpXS5zcGxpdCgvWygsICldL2cpLmZpbHRlcigoZSkgPT4gKGUpKTtcbiAgICAgIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAxKSB7XG4gICAgICAgIGlmIChzZWxlY3Rpb25bMF0gPT09ICcqJykgc2VsZWN0QXJyYXkucHVzaCgnKicpO1xuICAgICAgICBlbHNlIHNlbGVjdEFycmF5LnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHNlbGVjdGlvblswXSkpO1xuICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAyKSB7XG4gICAgICAgIHNlbGVjdEFycmF5LnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJyVzKFwiJXNcIiknLCBzZWxlY3Rpb25bMF0sIHNlbGVjdGlvblsxXSkpO1xuICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID49IDMgJiYgc2VsZWN0aW9uW3NlbGVjdGlvbi5sZW5ndGggLSAyXS50b0xvd2VyQ2FzZSgpID09PSAnYXMnKSB7XG4gICAgICAgIGNvbnN0IHNlbGVjdGlvbkVuZENodW5rID0gc2VsZWN0aW9uLnNwbGljZShzZWxlY3Rpb24ubGVuZ3RoIC0gMik7XG4gICAgICAgIGxldCBzZWxlY3Rpb25DaHVuayA9ICcnO1xuICAgICAgICBpZiAoc2VsZWN0aW9uLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgIHNlbGVjdGlvbkNodW5rID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHNlbGVjdGlvblswXSk7XG4gICAgICAgIH0gZWxzZSBpZiAoc2VsZWN0aW9uLmxlbmd0aCA9PT0gMikge1xuICAgICAgICAgIHNlbGVjdGlvbkNodW5rID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJyVzKFwiJXNcIiknLCBzZWxlY3Rpb25bMF0sIHNlbGVjdGlvblsxXSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc2VsZWN0aW9uQ2h1bmsgPSB1dGlsLmZvcm1hdCgnJXMoJXMpJywgc2VsZWN0aW9uWzBdLCBgXCIke3NlbGVjdGlvbi5zcGxpY2UoMSkuam9pbignXCIsXCInKX1cImApO1xuICAgICAgICB9XG4gICAgICAgIHNlbGVjdEFycmF5LnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJyVzIEFTIFwiJXNcIicsIHNlbGVjdGlvbkNodW5rLCBzZWxlY3Rpb25FbmRDaHVua1sxXSkpO1xuICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID49IDMpIHtcbiAgICAgICAgc2VsZWN0QXJyYXkucHVzaCh1dGlsLmZvcm1hdCgnJXMoJXMpJywgc2VsZWN0aW9uWzBdLCBgXCIke3NlbGVjdGlvbi5zcGxpY2UoMSkuam9pbignXCIsXCInKX1cImApKTtcbiAgICAgIH1cbiAgICB9XG4gICAgc2VsZWN0Q2xhdXNlID0gc2VsZWN0QXJyYXkuam9pbignLCcpO1xuICB9XG4gIHJldHVybiBzZWxlY3RDbGF1c2U7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IHBhcnNlcjtcbiJdfQ==