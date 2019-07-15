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

parser.formatJSONBColumnAware = function f(formatString) {

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
parser.db_value_without_bind_for_JSONB_YCQL_Bug = function f(schema, fieldName, fieldValue) {

  var isJsonbAttr = fieldName.indexOf("->") !== -1;
  if (isJsonbAttr) {
    var fieldNameRoot = fieldName.substr(0, fieldName.indexOf("->")).replace(/\"/g, "");
    var fieldRootType = schema.fields[fieldNameRoot].type || null;
    if (fieldRootType === "jsonb") {
      return JSON.stringify(fieldValue);
    }
  }
  // else{
  //   const fieldNameRoot = fieldName.replace(/\"/g, "");
  //   const fieldRootType = schema.fields[fieldNameRoot].type || null;
  //   if(fieldRootType === "jsonb"){
  //     return JSON.stringify(fieldValue);
  //   }
  // }

  return null;
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

    var _jsonbUnbindedBecauseOfBug = parser.db_value_without_bind_for_JSONB_YCQL_Bug(schema, fieldName, fieldValue);
    if (_jsonbUnbindedBecauseOfBug) {
      return _jsonbUnbindedBecauseOfBug;
    }

    return { query_segment: '?', parameter: val };
  }

  var jsonbUnbindedBecauseOfBug = parser.db_value_without_bind_for_JSONB_YCQL_Bug(schema, fieldName, fieldValue);

  var validationMessage = schemer.get_validation_message(validators, jsonbUnbindedBecauseOfBug || fieldValue);
  if (typeof validationMessage === 'function') {
    throw buildError('model.validator.invalidvalue', validationMessage(jsonbUnbindedBecauseOfBug || fieldValue, fieldName, fieldType));
  }

  if (jsonbUnbindedBecauseOfBug) {
    return jsonbUnbindedBecauseOfBug;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9wYXJzZXIuanMiXSwibmFtZXMiOlsiUHJvbWlzZSIsInJlcXVpcmUiLCJfIiwidXRpbCIsImRzZURyaXZlciIsImUiLCJjcWwiLCJwcm9taXNpZnlBbGwiLCJidWlsZEVycm9yIiwiZGF0YXR5cGVzIiwic2NoZW1lciIsInBhcnNlciIsInNldENoYXJBdCIsInN0ciIsImluZGV4IiwiY2hyIiwic3Vic3RyIiwiZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSIsImYiLCJmb3JtYXRTdHJpbmciLCJwbGFjZWhvbGRlcnMiLCJyZSIsIm1hdGNoIiwiZXhlYyIsInB1c2giLCJwYXJhbXMiLCJmb3JFYWNoIiwicCIsImkiLCJsZW5ndGgiLCJpbmRleE9mIiwiZnAiLCJmb3JtYXQiLCJkYl92YWx1ZV93aXRob3V0X2JpbmRfZm9yX0pTT05CX1lDUUxfQnVnIiwic2NoZW1hIiwiZmllbGROYW1lIiwiZmllbGRWYWx1ZSIsImlzSnNvbmJBdHRyIiwiZmllbGROYW1lUm9vdCIsInJlcGxhY2UiLCJmaWVsZFJvb3RUeXBlIiwiZmllbGRzIiwidHlwZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJjYWxsYmFja19vcl90aHJvdyIsImVyciIsImNhbGxiYWNrIiwiZXh0cmFjdF90eXBlIiwidmFsIiwiZGVjb21wb3NlZCIsInNwbGl0IiwiZCIsImhhcyIsImV4dHJhY3RfdHlwZURlZiIsImV4dHJhY3RfYWx0ZXJlZF90eXBlIiwibm9ybWFsaXplZE1vZGVsU2NoZW1hIiwiZGlmZiIsInBhdGgiLCJyaHMiLCJ0eXBlRGVmIiwiZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24iLCJ0eXBlcyIsInVuc2V0IiwicXVlcnlfc2VnbWVudCIsInBhcmFtZXRlciIsImlzUGxhaW5PYmplY3QiLCIkZGJfZnVuY3Rpb24iLCJmaWVsZFR5cGUiLCJnZXRfZmllbGRfdHlwZSIsInZhbGlkYXRvcnMiLCJnZXRfdmFsaWRhdG9ycyIsImlzQXJyYXkiLCJtYXAiLCJ2IiwiZGJWYWwiLCJqc29uYlVuYmluZGVkQmVjYXVzZU9mQnVnIiwidmFsaWRhdGlvbk1lc3NhZ2UiLCJnZXRfdmFsaWRhdGlvbl9tZXNzYWdlIiwiY291bnRlclF1ZXJ5U2VnbWVudCIsIk1hdGgiLCJhYnMiLCJ1bnNldF9ub3RfYWxsb3dlZCIsIm9wZXJhdGlvbiIsImlzX3ByaW1hcnlfa2V5X2ZpZWxkIiwiaXNfcmVxdWlyZWRfZmllbGQiLCJnZXRfaW5wbGFjZV91cGRhdGVfZXhwcmVzc2lvbiIsInVwZGF0ZUNsYXVzZXMiLCJxdWVyeVBhcmFtcyIsIiRhZGQiLCIkYXBwZW5kIiwiJHByZXBlbmQiLCIkcmVwbGFjZSIsIiRyZW1vdmUiLCJpbmNsdWRlcyIsIk9iamVjdCIsImtleXMiLCJyZXBsYWNlS2V5cyIsInJlcGxhY2VWYWx1ZXMiLCJ2YWx1ZXMiLCJnZXRfdXBkYXRlX3ZhbHVlX2V4cHJlc3Npb24iLCJpbnN0YW5jZSIsInVwZGF0ZVZhbHVlcyIsIm9wdGlvbnMiLCJ0aW1lc3RhbXBzIiwidXBkYXRlZEF0IiwidmVyc2lvbnMiLCJrZXkiLCJlcnJvckhhcHBlbmVkIiwic29tZSIsInVuZGVmaW5lZCIsInZpcnR1YWwiLCJfZ2V0X2RlZmF1bHRfdmFsdWUiLCJydWxlIiwiaWdub3JlX2RlZmF1bHQiLCJ2YWxpZGF0ZSIsImdldF9zYXZlX3ZhbHVlX2V4cHJlc3Npb24iLCJmbiIsImlkZW50aWZpZXJzIiwiZXh0cmFjdF9xdWVyeV9yZWxhdGlvbnMiLCJyZWxhdGlvbktleSIsInJlbGF0aW9uVmFsdWUiLCJ2YWxpZE9wZXJhdG9ycyIsInF1ZXJ5UmVsYXRpb25zIiwidG9Mb3dlckNhc2UiLCJvcGVyYXRvciIsIndoZXJlVGVtcGxhdGUiLCJidWlsZFF1ZXJ5UmVsYXRpb25zIiwiZmllbGROYW1lTG9jYWwiLCJyZWxhdGlvblZhbHVlTG9jYWwiLCJidWlsZFRva2VuUXVlcnlSZWxhdGlvbnMiLCJ0b2tlblJlbGF0aW9uS2V5IiwidG9rZW5SZWxhdGlvblZhbHVlIiwidG9rZW5LZXlzIiwidG9rZW5JbmRleCIsInRyaW0iLCJqb2luIiwidG9TdHJpbmciLCJ0b2tlblJlbGF0aW9uS2V5cyIsInRva2VuUksiLCJmaWVsZFR5cGUxIiwiZmllbGRUeXBlMiIsIl9wYXJzZV9xdWVyeV9vYmplY3QiLCJxdWVyeU9iamVjdCIsInN0YXJ0c1dpdGgiLCJxdWVyeSIsIndoZXJlT2JqZWN0IiwiZmsiLCJmaWVsZFJlbGF0aW9uIiwiY3FsT3BlcmF0b3JzIiwiJGVxIiwiJG5lIiwiJGlzbnQiLCIkZ3QiLCIkbHQiLCIkZ3RlIiwiJGx0ZSIsIiRpbiIsIiRsaWtlIiwiJHRva2VuIiwiJGNvbnRhaW5zIiwiJGNvbnRhaW5zX2tleSIsInZhbGlkS2V5cyIsImZpZWxkUmVsYXRpb25LZXlzIiwicmVsYXRpb25LZXlzIiwicmsiLCJleHRyYWN0ZWRSZWxhdGlvbnMiLCJjb25jYXQiLCJnZXRfZmlsdGVyX2NsYXVzZSIsImNsYXVzZSIsInBhcnNlZE9iamVjdCIsImZpbHRlckNsYXVzZSIsImdldF9maWx0ZXJfY2xhdXNlX2RkbCIsImZpbHRlclF1ZXJ5IiwicGFyYW0iLCJxdWVyeVBhcmFtIiwiRGF0ZSIsInRvSVNPU3RyaW5nIiwiTG9uZyIsIkludGVnZXIiLCJCaWdEZWNpbWFsIiwiVGltZVV1aWQiLCJVdWlkIiwiTG9jYWxEYXRlIiwiTG9jYWxUaW1lIiwiSW5ldEFkZHJlc3MiLCJnZXRfd2hlcmVfY2xhdXNlIiwiZ2V0X2lmX2NsYXVzZSIsImdldF9wcmltYXJ5X2tleV9jbGF1c2VzIiwicGFydGl0aW9uS2V5IiwiY2x1c3RlcmluZ0tleSIsInNsaWNlIiwiY2x1c3RlcmluZ09yZGVyIiwiZmllbGQiLCJjbHVzdGVyaW5nX29yZGVyIiwiY2x1c3RlcmluZ09yZGVyQ2xhdXNlIiwicGFydGl0aW9uS2V5Q2xhdXNlIiwiY2x1c3RlcmluZ0tleUNsYXVzZSIsImdldF9tdmlld193aGVyZV9jbGF1c2UiLCJ2aWV3U2NoZW1hIiwiY2xhdXNlcyIsIndoZXJlQ2xhdXNlIiwiZmlsdGVycyIsImNsb25lRGVlcCIsImZpbHRlcktleSIsInF1b3RlZEZpZWxkTmFtZXMiLCJ1bnF1b3RlZEZpZWxkTmFtZSIsInJlc2VydmVkS2V5d29yZHMiLCJ0b1VwcGVyQ2FzZSIsImdldF9vcmRlcmJ5X2NsYXVzZSIsIm9yZGVyS2V5cyIsImsiLCJxdWVyeUl0ZW0iLCJvcmRlckl0ZW1LZXlzIiwiY3FsT3JkZXJEaXJlY3Rpb24iLCIkYXNjIiwiJGRlc2MiLCJvcmRlckZpZWxkcyIsImoiLCJnZXRfZ3JvdXBieV9jbGF1c2UiLCJncm91cGJ5S2V5cyIsIkFycmF5IiwiZ2V0X2xpbWl0X2NsYXVzZSIsImxpbWl0IiwiZ2V0X3NlbGVjdF9jbGF1c2UiLCJzZWxlY3RDbGF1c2UiLCJzZWxlY3QiLCJzZWxlY3RBcnJheSIsInNlbGVjdGlvbiIsImZpbHRlciIsInNlbGVjdGlvbkVuZENodW5rIiwic3BsaWNlIiwic2VsZWN0aW9uQ2h1bmsiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOztBQUFBLElBQU1BLFVBQVVDLFFBQVEsVUFBUixDQUFoQjtBQUNBLElBQU1DLElBQUlELFFBQVEsUUFBUixDQUFWO0FBQ0EsSUFBTUUsT0FBT0YsUUFBUSxNQUFSLENBQWI7O0FBRUEsSUFBSUcsa0JBQUo7QUFDQSxJQUFJO0FBQ0Y7QUFDQUEsY0FBWUgsUUFBUSxZQUFSLENBQVo7QUFDRCxDQUhELENBR0UsT0FBT0ksQ0FBUCxFQUFVO0FBQ1ZELGNBQVksSUFBWjtBQUNEOztBQUVELElBQU1FLE1BQU1OLFFBQVFPLFlBQVIsQ0FBcUJILGFBQWFILFFBQVEsa0JBQVIsQ0FBbEMsQ0FBWjs7QUFFQSxJQUFNTyxhQUFhUCxRQUFRLHdCQUFSLENBQW5CO0FBQ0EsSUFBTVEsWUFBWVIsUUFBUSx5QkFBUixDQUFsQjtBQUNBLElBQU1TLFVBQVVULFFBQVEsc0JBQVIsQ0FBaEI7O0FBRUEsSUFBTVUsU0FBUyxFQUFmO0FBQ0EsSUFBTUMsWUFBWSxTQUFaQSxTQUFZLENBQUNDLEdBQUQsRUFBS0MsS0FBTCxFQUFZQyxHQUFaO0FBQUEsU0FBb0JGLElBQUlHLE1BQUos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QUFaLEVBQXNCb00sVUFBVSxDQUFWLENBQXRCLEVBQXFDLElBQUdBLFVBQVVHLE1BQVYsQ0FBaUIsQ0FBakIsRUFBb0IvRixJQUFwQixDQUF5QixLQUF6QixDQUFnQyxHQUF4RSxDQUFqQjtBQUNEO0FBQ0QyRixvQkFBWTNNLElBQVosQ0FBaUJiLE9BQU9NLHNCQUFQLENBQThCLFlBQTlCLEVBQTRDdU4sY0FBNUMsRUFBNERGLGtCQUFrQixDQUFsQixDQUE1RCxDQUFqQjtBQUNELE9BWE0sTUFXQSxJQUFJRixVQUFVdk0sTUFBVixJQUFvQixDQUF4QixFQUEyQjtBQUNoQ3NNLG9CQUFZM00sSUFBWixDQUFpQnJCLEtBQUs2QixNQUFMLENBQVksUUFBWixFQUFzQm9NLFVBQVUsQ0FBVixDQUF0QixFQUFxQyxJQUFHQSxVQUFVRyxNQUFWLENBQWlCLENBQWpCLEVBQW9CL0YsSUFBcEIsQ0FBeUIsS0FBekIsQ0FBZ0MsR0FBeEUsQ0FBakI7QUFDRDtBQUNGO0FBQ0R5RixtQkFBZUUsWUFBWTNGLElBQVosQ0FBaUIsR0FBakIsQ0FBZjtBQUNEO0FBQ0QsU0FBT3lGLFlBQVA7QUFDRCxDQTlCRDs7QUFnQ0FRLE9BQU9DLE9BQVAsR0FBaUIvTixNQUFqQiIsImZpbGUiOiJwYXJzZXIuanMiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCBQcm9taXNlID0gcmVxdWlyZSgnYmx1ZWJpcmQnKTtcbmNvbnN0IF8gPSByZXF1aXJlKCdsb2Rhc2gnKTtcbmNvbnN0IHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5cbmxldCBkc2VEcml2ZXI7XG50cnkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgaW1wb3J0L25vLWV4dHJhbmVvdXMtZGVwZW5kZW5jaWVzLCBpbXBvcnQvbm8tdW5yZXNvbHZlZFxuICBkc2VEcml2ZXIgPSByZXF1aXJlKCdkc2UtZHJpdmVyJyk7XG59IGNhdGNoIChlKSB7XG4gIGRzZURyaXZlciA9IG51bGw7XG59XG5cbmNvbnN0IGNxbCA9IFByb21pc2UucHJvbWlzaWZ5QWxsKGRzZURyaXZlciB8fCByZXF1aXJlKCdjYXNzYW5kcmEtZHJpdmVyJykpO1xuXG5jb25zdCBidWlsZEVycm9yID0gcmVxdWlyZSgnLi4vb3JtL2Fwb2xsb19lcnJvci5qcycpO1xuY29uc3QgZGF0YXR5cGVzID0gcmVxdWlyZSgnLi4vdmFsaWRhdG9ycy9kYXRhdHlwZXMnKTtcbmNvbnN0IHNjaGVtZXIgPSByZXF1aXJlKCcuLi92YWxpZGF0b3JzL3NjaGVtYScpO1xuXG5jb25zdCBwYXJzZXIgPSB7fTtcbmNvbnN0IHNldENoYXJBdCA9IChzdHIsaW5kZXgsIGNocikgPT4gc3RyLnN1YnN0cigwLGluZGV4KSArIGNociArIHN0ci5zdWJzdHIoaW5kZXgrMSk7XG5cbnBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlID0gZnVuY3Rpb24gZihmb3JtYXRTdHJpbmcsIC4uLnBhcmFtcyl7XG5cbiAgY29uc3QgcGxhY2Vob2xkZXJzID0gW107XG5cbiAgY29uc3QgcmUgPSAvJS4vZztcbiAgbGV0IG1hdGNoO1xuICBkbyB7XG4gICAgICBtYXRjaCA9IHJlLmV4ZWMoZm9ybWF0U3RyaW5nKTtcbiAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICAgIHBsYWNlaG9sZGVycy5wdXNoKG1hdGNoKVxuICAgICAgfVxuICB9IHdoaWxlIChtYXRjaCk7XG5cbiAgKHBhcmFtcyB8fCBbXSkuZm9yRWFjaCgocCxpKSA9PiB7XG4gICAgaWYoaSA8IHBsYWNlaG9sZGVycy5sZW5ndGggJiYgdHlwZW9mKHApID09PSBcInN0cmluZ1wiICYmIHAuaW5kZXhPZihcIi0+XCIpICE9PSAtMSl7XG4gICAgICBjb25zdCBmcCA9IHBsYWNlaG9sZGVyc1tpXTtcbiAgICAgIGlmKFxuICAgICAgICBmcC5pbmRleCA+IDAgJiZcbiAgICAgICAgZm9ybWF0U3RyaW5nLmxlbmd0aCA+IGZwLmluZGV4KzIgJiZcbiAgICAgICAgZm9ybWF0U3RyaW5nW2ZwLmluZGV4LTFdID09PSAnXCInICYmXG4gICAgICAgIGZvcm1hdFN0cmluZ1tmcC5pbmRleCsyXSA9PT0gJ1wiJ1xuICAgICAgKXtcbiAgICAgICAgZm9ybWF0U3RyaW5nID0gc2V0Q2hhckF0KGZvcm1hdFN0cmluZywgZnAuaW5kZXgtMSwgXCIgXCIpO1xuICAgICAgICBmb3JtYXRTdHJpbmcgPSBzZXRDaGFyQXQoZm9ybWF0U3RyaW5nLCBmcC5pbmRleCsyLCBcIiBcIik7XG4gICAgICB9XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4gdXRpbC5mb3JtYXQoZm9ybWF0U3RyaW5nLCAuLi5wYXJhbXMpO1xufVxucGFyc2VyLmRiX3ZhbHVlX3dpdGhvdXRfYmluZF9mb3JfSlNPTkJfWUNRTF9CdWcgPSBmdW5jdGlvbiBmKHNjaGVtYSwgZmllbGROYW1lLCBmaWVsZFZhbHVlKXtcbiAgXG4gIGNvbnN0IGlzSnNvbmJBdHRyID0gZmllbGROYW1lLmluZGV4T2YoXCItPlwiKSAhPT0gLTE7XG4gIGlmKGlzSnNvbmJBdHRyKXtcbiAgICBjb25zdCBmaWVsZE5hbWVSb290ID0gZmllbGROYW1lLnN1YnN0cigwLCBmaWVsZE5hbWUuaW5kZXhPZihcIi0+XCIpKS5yZXBsYWNlKC9cXFwiL2csIFwiXCIpO1xuICAgIGNvbnN0IGZpZWxkUm9vdFR5cGUgPSBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZVJvb3RdLnR5cGUgfHzCoG51bGw7XG4gICAgaWYoZmllbGRSb290VHlwZSA9PT0gXCJqc29uYlwiKXtcbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShmaWVsZFZhbHVlKTtcbiAgICB9XG4gIH1cbiAgLy8gZWxzZXtcbiAgLy8gICBjb25zdCBmaWVsZE5hbWVSb290ID0gZmllbGROYW1lLnJlcGxhY2UoL1xcXCIvZywgXCJcIik7XG4gIC8vICAgY29uc3QgZmllbGRSb290VHlwZSA9IHNjaGVtYS5maWVsZHNbZmllbGROYW1lUm9vdF0udHlwZSB8fMKgbnVsbDtcbiAgLy8gICBpZihmaWVsZFJvb3RUeXBlID09PSBcImpzb25iXCIpe1xuICAvLyAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGZpZWxkVmFsdWUpO1xuICAvLyAgIH1cbiAgLy8gfVxuICBcbiAgcmV0dXJuIG51bGw7XG59XG5cbnBhcnNlci5jYWxsYmFja19vcl90aHJvdyA9IGZ1bmN0aW9uIGYoZXJyLCBjYWxsYmFjaykge1xuICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2FsbGJhY2soZXJyKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdGhyb3cgKGVycik7XG59O1xuXG5wYXJzZXIuZXh0cmFjdF90eXBlID0gZnVuY3Rpb24gZih2YWwpIHtcbiAgLy8gZGVjb21wb3NlIGNvbXBvc2l0ZSB0eXBlc1xuICBjb25zdCBkZWNvbXBvc2VkID0gdmFsID8gdmFsLnJlcGxhY2UoL1tcXHNdL2csICcnKS5zcGxpdCgvWzwsPl0vZykgOiBbJyddO1xuXG4gIGZvciAobGV0IGQgPSAwOyBkIDwgZGVjb21wb3NlZC5sZW5ndGg7IGQrKykge1xuICAgIGlmIChfLmhhcyhkYXRhdHlwZXMsIGRlY29tcG9zZWRbZF0pKSB7XG4gICAgICByZXR1cm4gZGVjb21wb3NlZFtkXTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdmFsO1xufTtcblxucGFyc2VyLmV4dHJhY3RfdHlwZURlZiA9IGZ1bmN0aW9uIGYodmFsKSB7XG4gIC8vIGRlY29tcG9zZSBjb21wb3NpdGUgdHlwZXNcbiAgbGV0IGRlY29tcG9zZWQgPSB2YWwgPyB2YWwucmVwbGFjZSgvW1xcc10vZywgJycpIDogJyc7XG4gIGRlY29tcG9zZWQgPSBkZWNvbXBvc2VkLnN1YnN0cihkZWNvbXBvc2VkLmluZGV4T2YoJzwnKSwgZGVjb21wb3NlZC5sZW5ndGggLSBkZWNvbXBvc2VkLmluZGV4T2YoJzwnKSk7XG5cbiAgcmV0dXJuIGRlY29tcG9zZWQ7XG59O1xuXG5wYXJzZXIuZXh0cmFjdF9hbHRlcmVkX3R5cGUgPSBmdW5jdGlvbiBmKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSwgZGlmZikge1xuICBjb25zdCBmaWVsZE5hbWUgPSBkaWZmLnBhdGhbMF07XG4gIGxldCB0eXBlID0gJyc7XG4gIGlmIChkaWZmLnBhdGgubGVuZ3RoID4gMSkge1xuICAgIGlmIChkaWZmLnBhdGhbMV0gPT09ICd0eXBlJykge1xuICAgICAgdHlwZSA9IGRpZmYucmhzO1xuICAgICAgaWYgKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlRGVmKSB7XG4gICAgICAgIHR5cGUgKz0gbm9ybWFsaXplZE1vZGVsU2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGVEZWY7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHR5cGUgPSBub3JtYWxpemVkTW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZTtcbiAgICAgIHR5cGUgKz0gZGlmZi5yaHM7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHR5cGUgPSBkaWZmLnJocy50eXBlO1xuICAgIGlmIChkaWZmLnJocy50eXBlRGVmKSB0eXBlICs9IGRpZmYucmhzLnR5cGVEZWY7XG4gIH1cbiAgcmV0dXJuIHR5cGU7XG59O1xuXG5wYXJzZXIuZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24gPSBmdW5jdGlvbiBmKHNjaGVtYSwgZmllbGROYW1lLCBmaWVsZFZhbHVlKSB7XG4gIGlmIChmaWVsZFZhbHVlID09IG51bGwgfHwgZmllbGRWYWx1ZSA9PT0gY3FsLnR5cGVzLnVuc2V0KSB7XG4gICAgcmV0dXJuIHsgcXVlcnlfc2VnbWVudDogJz8nLCBwYXJhbWV0ZXI6IGZpZWxkVmFsdWUgfTtcbiAgfVxuXG4gIGlmIChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kZGJfZnVuY3Rpb24pIHtcbiAgICByZXR1cm4gZmllbGRWYWx1ZS4kZGJfZnVuY3Rpb247XG4gIH1cblxuICBjb25zdCBmaWVsZFR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwgZmllbGROYW1lKTtcbiAgY29uc3QgdmFsaWRhdG9ycyA9IHNjaGVtZXIuZ2V0X3ZhbGlkYXRvcnMoc2NoZW1hLCBmaWVsZE5hbWUpO1xuXG4gIGlmIChfLmlzQXJyYXkoZmllbGRWYWx1ZSkgJiYgZmllbGRUeXBlICE9PSAnbGlzdCcgJiYgZmllbGRUeXBlICE9PSAnc2V0JyAmJiBmaWVsZFR5cGUgIT09ICdmcm96ZW4nKSB7XG4gICAgY29uc3QgdmFsID0gZmllbGRWYWx1ZS5tYXAoKHYpID0+IHtcbiAgICAgIGNvbnN0IGRiVmFsID0gcGFyc2VyLmdldF9kYl92YWx1ZV9leHByZXNzaW9uKHNjaGVtYSwgZmllbGROYW1lLCB2KTtcblxuICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkgcmV0dXJuIGRiVmFsLnBhcmFtZXRlcjtcbiAgICAgIHJldHVybiBkYlZhbDtcbiAgICB9KTtcblxuICAgIGNvbnN0IGpzb25iVW5iaW5kZWRCZWNhdXNlT2ZCdWcgPSBwYXJzZXIuZGJfdmFsdWVfd2l0aG91dF9iaW5kX2Zvcl9KU09OQl9ZQ1FMX0J1ZyhzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgaWYoanNvbmJVbmJpbmRlZEJlY2F1c2VPZkJ1Zyl7XG4gICAgICByZXR1cm4ganNvbmJVbmJpbmRlZEJlY2F1c2VPZkJ1ZztcbiAgICB9XG5cbiAgICByZXR1cm4geyBxdWVyeV9zZWdtZW50OiAnPycsIHBhcmFtZXRlcjogdmFsIH07XG4gIH1cblxuICBjb25zdCBqc29uYlVuYmluZGVkQmVjYXVzZU9mQnVnID0gcGFyc2VyLmRiX3ZhbHVlX3dpdGhvdXRfYmluZF9mb3JfSlNPTkJfWUNRTF9CdWcoc2NoZW1hLCBmaWVsZE5hbWUsIGZpZWxkVmFsdWUpO1xuXG4gIGNvbnN0IHZhbGlkYXRpb25NZXNzYWdlID0gc2NoZW1lci5nZXRfdmFsaWRhdGlvbl9tZXNzYWdlKHZhbGlkYXRvcnMsIGpzb25iVW5iaW5kZWRCZWNhdXNlT2ZCdWcgfHwgZmllbGRWYWx1ZSk7XG4gIGlmICh0eXBlb2YgdmFsaWRhdGlvbk1lc3NhZ2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWR2YWx1ZScsIHZhbGlkYXRpb25NZXNzYWdlKGpzb25iVW5iaW5kZWRCZWNhdXNlT2ZCdWcgfHwgZmllbGRWYWx1ZSwgZmllbGROYW1lLCBmaWVsZFR5cGUpKSk7XG4gIH1cblxuICBpZihqc29uYlVuYmluZGVkQmVjYXVzZU9mQnVnKXtcbiAgICByZXR1cm4ganNvbmJVbmJpbmRlZEJlY2F1c2VPZkJ1ZztcbiAgfVxuXG4gIGlmIChmaWVsZFR5cGUgPT09ICdjb3VudGVyJykge1xuICAgIGxldCBjb3VudGVyUXVlcnlTZWdtZW50ID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIGZpZWxkTmFtZSk7XG4gICAgaWYgKGZpZWxkVmFsdWUgPj0gMCkgY291bnRlclF1ZXJ5U2VnbWVudCArPSAnICsgPyc7XG4gICAgZWxzZSBjb3VudGVyUXVlcnlTZWdtZW50ICs9ICcgLSA/JztcbiAgICBmaWVsZFZhbHVlID0gTWF0aC5hYnMoZmllbGRWYWx1ZSk7XG4gICAgcmV0dXJuIHsgcXVlcnlfc2VnbWVudDogY291bnRlclF1ZXJ5U2VnbWVudCwgcGFyYW1ldGVyOiBmaWVsZFZhbHVlIH07XG4gIH1cblxuICByZXR1cm4geyBxdWVyeV9zZWdtZW50OiAnPycsIHBhcmFtZXRlcjogZmllbGRWYWx1ZSB9O1xufTtcblxucGFyc2VyLnVuc2V0X25vdF9hbGxvd2VkID0gZnVuY3Rpb24gZihvcGVyYXRpb24sIHNjaGVtYSwgZmllbGROYW1lLCBjYWxsYmFjaykge1xuICBpZiAoc2NoZW1lci5pc19wcmltYXJ5X2tleV9maWVsZChzY2hlbWEsIGZpZWxkTmFtZSkpIHtcbiAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coYnVpbGRFcnJvcihgbW9kZWwuJHtvcGVyYXRpb259LnVuc2V0a2V5YCwgZmllbGROYW1lKSwgY2FsbGJhY2spO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmIChzY2hlbWVyLmlzX3JlcXVpcmVkX2ZpZWxkKHNjaGVtYSwgZmllbGROYW1lKSkge1xuICAgIHBhcnNlci5jYWxsYmFja19vcl90aHJvdyhidWlsZEVycm9yKGBtb2RlbC4ke29wZXJhdGlvbn0udW5zZXRyZXF1aXJlZGAsIGZpZWxkTmFtZSksIGNhbGxiYWNrKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59O1xuXG5wYXJzZXIuZ2V0X2lucGxhY2VfdXBkYXRlX2V4cHJlc3Npb24gPSBmdW5jdGlvbiBmKHNjaGVtYSwgZmllbGROYW1lLCBmaWVsZFZhbHVlLCB1cGRhdGVDbGF1c2VzLCBxdWVyeVBhcmFtcykge1xuICBjb25zdCAkYWRkID0gKF8uaXNQbGFpbk9iamVjdChmaWVsZFZhbHVlKSAmJiBmaWVsZFZhbHVlLiRhZGQpIHx8IGZhbHNlO1xuICBjb25zdCAkYXBwZW5kID0gKF8uaXNQbGFpbk9iamVjdChmaWVsZFZhbHVlKSAmJiBmaWVsZFZhbHVlLiRhcHBlbmQpIHx8IGZhbHNlO1xuICBjb25zdCAkcHJlcGVuZCA9IChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kcHJlcGVuZCkgfHwgZmFsc2U7XG4gIGNvbnN0ICRyZXBsYWNlID0gKF8uaXNQbGFpbk9iamVjdChmaWVsZFZhbHVlKSAmJiBmaWVsZFZhbHVlLiRyZXBsYWNlKSB8fCBmYWxzZTtcbiAgY29uc3QgJHJlbW92ZSA9IChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kcmVtb3ZlKSB8fCBmYWxzZTtcblxuICBmaWVsZFZhbHVlID0gJGFkZCB8fCAkYXBwZW5kIHx8ICRwcmVwZW5kIHx8ICRyZXBsYWNlIHx8ICRyZW1vdmUgfHwgZmllbGRWYWx1ZTtcblxuICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG5cbiAgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGJWYWwpIHx8ICFkYlZhbC5xdWVyeV9zZWdtZW50KSB7XG4gICAgdXBkYXRlQ2xhdXNlcy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCI9JXMnLCBmaWVsZE5hbWUsIGRiVmFsKSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgZmllbGRUeXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG5cbiAgaWYgKFsnbWFwJywgJ2xpc3QnLCAnc2V0J10uaW5jbHVkZXMoZmllbGRUeXBlKSkge1xuICAgIGlmICgkYWRkIHx8ICRhcHBlbmQpIHtcbiAgICAgIGRiVmFsLnF1ZXJ5X3NlZ21lbnQgPSBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiICsgJXMnLCBmaWVsZE5hbWUsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpO1xuICAgIH0gZWxzZSBpZiAoJHByZXBlbmQpIHtcbiAgICAgIGlmIChmaWVsZFR5cGUgPT09ICdsaXN0Jykge1xuICAgICAgICBkYlZhbC5xdWVyeV9zZWdtZW50ID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJyVzICsgXCIlc1wiJywgZGJWYWwucXVlcnlfc2VnbWVudCwgZmllbGROYW1lKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKFxuICAgICAgICAgICdtb2RlbC51cGRhdGUuaW52YWxpZHByZXBlbmRvcCcsXG4gICAgICAgICAgdXRpbC5mb3JtYXQoJyVzIGRhdGF0eXBlcyBkb2VzIG5vdCBzdXBwb3J0ICRwcmVwZW5kLCB1c2UgJGFkZCBpbnN0ZWFkJywgZmllbGRUeXBlKSxcbiAgICAgICAgKSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICgkcmVtb3ZlKSB7XG4gICAgICBkYlZhbC5xdWVyeV9zZWdtZW50ID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIiAtICVzJywgZmllbGROYW1lLCBkYlZhbC5xdWVyeV9zZWdtZW50KTtcbiAgICAgIGlmIChmaWVsZFR5cGUgPT09ICdtYXAnKSBkYlZhbC5wYXJhbWV0ZXIgPSBPYmplY3Qua2V5cyhkYlZhbC5wYXJhbWV0ZXIpO1xuICAgIH1cbiAgfVxuXG4gIGlmICgkcmVwbGFjZSkge1xuICAgIGlmIChmaWVsZFR5cGUgPT09ICdtYXAnKSB7XG4gICAgICB1cGRhdGVDbGF1c2VzLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIls/XT0lcycsIGZpZWxkTmFtZSwgZGJWYWwucXVlcnlfc2VnbWVudCkpO1xuICAgICAgY29uc3QgcmVwbGFjZUtleXMgPSBPYmplY3Qua2V5cyhkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgY29uc3QgcmVwbGFjZVZhbHVlcyA9IF8udmFsdWVzKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICBpZiAocmVwbGFjZUtleXMubGVuZ3RoID09PSAxKSB7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2gocmVwbGFjZUtleXNbMF0pO1xuICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKHJlcGxhY2VWYWx1ZXNbMF0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgKFxuICAgICAgICAgIGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5pbnZhbGlkcmVwbGFjZW9wJywgJyRyZXBsYWNlIGluIG1hcCBkb2VzIG5vdCBzdXBwb3J0IG1vcmUgdGhhbiBvbmUgaXRlbScpXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChmaWVsZFR5cGUgPT09ICdsaXN0Jykge1xuICAgICAgdXBkYXRlQ2xhdXNlcy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCJbP109JXMnLCBmaWVsZE5hbWUsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpKTtcbiAgICAgIGlmIChkYlZhbC5wYXJhbWV0ZXIubGVuZ3RoID09PSAyKSB7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyWzBdKTtcbiAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXJbMV0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoXG4gICAgICAgICAgJ21vZGVsLnVwZGF0ZS5pbnZhbGlkcmVwbGFjZW9wJyxcbiAgICAgICAgICAnJHJlcGxhY2UgaW4gbGlzdCBzaG91bGQgaGF2ZSBleGFjdGx5IDIgaXRlbXMsIGZpcnN0IG9uZSBhcyB0aGUgaW5kZXggYW5kIHRoZSBzZWNvbmQgb25lIGFzIHRoZSB2YWx1ZScsXG4gICAgICAgICkpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcihcbiAgICAgICAgJ21vZGVsLnVwZGF0ZS5pbnZhbGlkcmVwbGFjZW9wJyxcbiAgICAgICAgdXRpbC5mb3JtYXQoJyVzIGRhdGF0eXBlcyBkb2VzIG5vdCBzdXBwb3J0ICRyZXBsYWNlJywgZmllbGRUeXBlKSxcbiAgICAgICkpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB1cGRhdGVDbGF1c2VzLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIj0lcycsIGZpZWxkTmFtZSwgZGJWYWwucXVlcnlfc2VnbWVudCkpO1xuICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyKTtcbiAgfVxufTtcblxucGFyc2VyLmdldF91cGRhdGVfdmFsdWVfZXhwcmVzc2lvbiA9IGZ1bmN0aW9uIGYoaW5zdGFuY2UsIHNjaGVtYSwgdXBkYXRlVmFsdWVzLCBjYWxsYmFjaykge1xuICBjb25zdCB1cGRhdGVDbGF1c2VzID0gW107XG4gIGNvbnN0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgaWYgKHNjaGVtYS5vcHRpb25zICYmIHNjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMpIHtcbiAgICBpZiAoIXVwZGF0ZVZhbHVlc1tzY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzLnVwZGF0ZWRBdF0pIHtcbiAgICAgIHVwZGF0ZVZhbHVlc1tzY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzLnVwZGF0ZWRBdF0gPSB7ICRkYl9mdW5jdGlvbjogJ3RvVGltZXN0YW1wKG5vdygpKScgfTtcbiAgICB9XG4gIH1cblxuICBpZiAoc2NoZW1hLm9wdGlvbnMgJiYgc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMpIHtcbiAgICBpZiAoIXVwZGF0ZVZhbHVlc1tzY2hlbWEub3B0aW9ucy52ZXJzaW9ucy5rZXldKSB7XG4gICAgICB1cGRhdGVWYWx1ZXNbc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5XSA9IHsgJGRiX2Z1bmN0aW9uOiAnbm93KCknIH07XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZXJyb3JIYXBwZW5lZCA9IE9iamVjdC5rZXlzKHVwZGF0ZVZhbHVlcykuc29tZSgoZmllbGROYW1lKSA9PiB7XG4gICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSA9PT0gdW5kZWZpbmVkIHx8IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS52aXJ0dWFsKSByZXR1cm4gZmFsc2U7XG5cbiAgICBjb25zdCBmaWVsZFR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwgZmllbGROYW1lKTtcbiAgICBsZXQgZmllbGRWYWx1ZSA9IHVwZGF0ZVZhbHVlc1tmaWVsZE5hbWVdO1xuXG4gICAgaWYgKGZpZWxkVmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZmllbGRWYWx1ZSA9IGluc3RhbmNlLl9nZXRfZGVmYXVsdF92YWx1ZShmaWVsZE5hbWUpO1xuICAgICAgaWYgKGZpZWxkVmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXR1cm4gcGFyc2VyLnVuc2V0X25vdF9hbGxvd2VkKCd1cGRhdGUnLCBzY2hlbWEsIGZpZWxkTmFtZSwgY2FsbGJhY2spO1xuICAgICAgfSBlbHNlIGlmICghc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnJ1bGUgfHwgIXNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5ydWxlLmlnbm9yZV9kZWZhdWx0KSB7XG4gICAgICAgIC8vIGRpZCBzZXQgYSBkZWZhdWx0IHZhbHVlLCBpZ25vcmUgZGVmYXVsdCBpcyBub3Qgc2V0XG4gICAgICAgIGlmIChpbnN0YW5jZS52YWxpZGF0ZShmaWVsZE5hbWUsIGZpZWxkVmFsdWUpICE9PSB0cnVlKSB7XG4gICAgICAgICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5pbnZhbGlkZGVmYXVsdHZhbHVlJywgZmllbGRWYWx1ZSwgZmllbGROYW1lLCBmaWVsZFR5cGUpLCBjYWxsYmFjayk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZSA9PT0gbnVsbCB8fCBmaWVsZFZhbHVlID09PSBjcWwudHlwZXMudW5zZXQpIHtcbiAgICAgIGlmIChwYXJzZXIudW5zZXRfbm90X2FsbG93ZWQoJ3VwZGF0ZScsIHNjaGVtYSwgZmllbGROYW1lLCBjYWxsYmFjaykpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIHBhcnNlci5nZXRfaW5wbGFjZV91cGRhdGVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSwgdXBkYXRlQ2xhdXNlcywgcXVlcnlQYXJhbXMpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHBhcnNlci5jYWxsYmFja19vcl90aHJvdyhlLCBjYWxsYmFjayk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9KTtcblxuICByZXR1cm4geyB1cGRhdGVDbGF1c2VzLCBxdWVyeVBhcmFtcywgZXJyb3JIYXBwZW5lZCB9O1xufTtcblxucGFyc2VyLmdldF9zYXZlX3ZhbHVlX2V4cHJlc3Npb24gPSBmdW5jdGlvbiBmbihpbnN0YW5jZSwgc2NoZW1hLCBjYWxsYmFjaykge1xuICBjb25zdCBpZGVudGlmaWVycyA9IFtdO1xuICBjb25zdCB2YWx1ZXMgPSBbXTtcbiAgY29uc3QgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBpZiAoc2NoZW1hLm9wdGlvbnMgJiYgc2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcykge1xuICAgIGlmIChpbnN0YW5jZVtzY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzLnVwZGF0ZWRBdF0pIHtcbiAgICAgIGluc3RhbmNlW3NjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMudXBkYXRlZEF0XSA9IHsgJGRiX2Z1bmN0aW9uOiAndG9UaW1lc3RhbXAobm93KCkpJyB9O1xuICAgIH1cbiAgfVxuXG4gIGlmIChzY2hlbWEub3B0aW9ucyAmJiBzY2hlbWEub3B0aW9ucy52ZXJzaW9ucykge1xuICAgIGlmIChpbnN0YW5jZVtzY2hlbWEub3B0aW9ucy52ZXJzaW9ucy5rZXldKSB7XG4gICAgICBpbnN0YW5jZVtzY2hlbWEub3B0aW9ucy52ZXJzaW9ucy5rZXldID0geyAkZGJfZnVuY3Rpb246ICdub3coKScgfTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBlcnJvckhhcHBlbmVkID0gT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuc29tZSgoZmllbGROYW1lKSA9PiB7XG4gICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS52aXJ0dWFsKSByZXR1cm4gZmFsc2U7XG5cbiAgICAvLyBjaGVjayBmaWVsZCB2YWx1ZVxuICAgIGNvbnN0IGZpZWxkVHlwZSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBmaWVsZE5hbWUpO1xuICAgIGxldCBmaWVsZFZhbHVlID0gaW5zdGFuY2VbZmllbGROYW1lXTtcblxuICAgIGlmIChmaWVsZFZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGZpZWxkVmFsdWUgPSBpbnN0YW5jZS5fZ2V0X2RlZmF1bHRfdmFsdWUoZmllbGROYW1lKTtcbiAgICAgIGlmIChmaWVsZFZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIHBhcnNlci51bnNldF9ub3RfYWxsb3dlZCgnc2F2ZScsIHNjaGVtYSwgZmllbGROYW1lLCBjYWxsYmFjayk7XG4gICAgICB9IGVsc2UgaWYgKCFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0ucnVsZSB8fCAhc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnJ1bGUuaWdub3JlX2RlZmF1bHQpIHtcbiAgICAgICAgLy8gZGlkIHNldCBhIGRlZmF1bHQgdmFsdWUsIGlnbm9yZSBkZWZhdWx0IGlzIG5vdCBzZXRcbiAgICAgICAgaWYgKGluc3RhbmNlLnZhbGlkYXRlKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSkgIT09IHRydWUpIHtcbiAgICAgICAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5pbnZhbGlkZGVmYXVsdHZhbHVlJywgZmllbGRWYWx1ZSwgZmllbGROYW1lLCBmaWVsZFR5cGUpLCBjYWxsYmFjayk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZSA9PT0gbnVsbCB8fCBmaWVsZFZhbHVlID09PSBjcWwudHlwZXMudW5zZXQpIHtcbiAgICAgIGlmIChwYXJzZXIudW5zZXRfbm90X2FsbG93ZWQoJ3NhdmUnLCBzY2hlbWEsIGZpZWxkTmFtZSwgY2FsbGJhY2spKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlkZW50aWZpZXJzLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIGZpZWxkTmFtZSkpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRiVmFsID0gcGFyc2VyLmdldF9kYl92YWx1ZV9leHByZXNzaW9uKHNjaGVtYSwgZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHtcbiAgICAgICAgdmFsdWVzLnB1c2goZGJWYWwucXVlcnlfc2VnbWVudCk7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhbHVlcy5wdXNoKGRiVmFsKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coZSwgY2FsbGJhY2spO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSk7XG5cbiAgcmV0dXJuIHtcbiAgICBpZGVudGlmaWVycyxcbiAgICB2YWx1ZXMsXG4gICAgcXVlcnlQYXJhbXMsXG4gICAgZXJyb3JIYXBwZW5lZCxcbiAgfTtcbn07XG5cbnBhcnNlci5leHRyYWN0X3F1ZXJ5X3JlbGF0aW9ucyA9IGZ1bmN0aW9uIGYoZmllbGROYW1lLCByZWxhdGlvbktleSwgcmVsYXRpb25WYWx1ZSwgc2NoZW1hLCB2YWxpZE9wZXJhdG9ycykge1xuICBjb25zdCBxdWVyeVJlbGF0aW9ucyA9IFtdO1xuICBjb25zdCBxdWVyeVBhcmFtcyA9IFtdO1xuXG4gIGlmICghXy5oYXModmFsaWRPcGVyYXRvcnMsIHJlbGF0aW9uS2V5LnRvTG93ZXJDYXNlKCkpKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZG9wJywgcmVsYXRpb25LZXkpKTtcbiAgfVxuXG4gIHJlbGF0aW9uS2V5ID0gcmVsYXRpb25LZXkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKHJlbGF0aW9uS2V5ID09PSAnJGluJyAmJiAhXy5pc0FycmF5KHJlbGF0aW9uVmFsdWUpKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZGlub3AnKSk7XG4gIH1cbiAgaWYgKHJlbGF0aW9uS2V5ID09PSAnJHRva2VuJyAmJiAhKHJlbGF0aW9uVmFsdWUgaW5zdGFuY2VvZiBPYmplY3QpKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZHRva2VuJykpO1xuICB9XG5cbiAgbGV0IG9wZXJhdG9yID0gdmFsaWRPcGVyYXRvcnNbcmVsYXRpb25LZXldO1xuICBsZXQgd2hlcmVUZW1wbGF0ZSA9ICdcIiVzXCIgJXMgJXMnO1xuXG4gIGNvbnN0IGJ1aWxkUXVlcnlSZWxhdGlvbnMgPSAoZmllbGROYW1lTG9jYWwsIHJlbGF0aW9uVmFsdWVMb2NhbCkgPT4ge1xuICAgIGNvbnN0IGRiVmFsID0gcGFyc2VyLmdldF9kYl92YWx1ZV9leHByZXNzaW9uKHNjaGVtYSwgZmllbGROYW1lTG9jYWwsIHJlbGF0aW9uVmFsdWVMb2NhbCk7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZShcbiAgICAgICAgd2hlcmVUZW1wbGF0ZSxcbiAgICAgICAgZmllbGROYW1lTG9jYWwsIG9wZXJhdG9yLCBkYlZhbC5xdWVyeV9zZWdtZW50LFxuICAgICAgKSk7XG4gICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoXG4gICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgIGZpZWxkTmFtZUxvY2FsLCBvcGVyYXRvciwgZGJWYWwsXG4gICAgICApKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYnVpbGRUb2tlblF1ZXJ5UmVsYXRpb25zID0gKHRva2VuUmVsYXRpb25LZXksIHRva2VuUmVsYXRpb25WYWx1ZSkgPT4ge1xuICAgIHRva2VuUmVsYXRpb25LZXkgPSB0b2tlblJlbGF0aW9uS2V5LnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKF8uaGFzKHZhbGlkT3BlcmF0b3JzLCB0b2tlblJlbGF0aW9uS2V5KSAmJiB0b2tlblJlbGF0aW9uS2V5ICE9PSAnJHRva2VuJyAmJiB0b2tlblJlbGF0aW9uS2V5ICE9PSAnJGluJykge1xuICAgICAgb3BlcmF0b3IgPSB2YWxpZE9wZXJhdG9yc1t0b2tlblJlbGF0aW9uS2V5XTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZHRva2Vub3AnLCB0b2tlblJlbGF0aW9uS2V5KSk7XG4gICAgfVxuXG4gICAgaWYgKF8uaXNBcnJheSh0b2tlblJlbGF0aW9uVmFsdWUpKSB7XG4gICAgICBjb25zdCB0b2tlbktleXMgPSBmaWVsZE5hbWUuc3BsaXQoJywnKTtcbiAgICAgIGZvciAobGV0IHRva2VuSW5kZXggPSAwOyB0b2tlbkluZGV4IDwgdG9rZW5SZWxhdGlvblZhbHVlLmxlbmd0aDsgdG9rZW5JbmRleCsrKSB7XG4gICAgICAgIHRva2VuS2V5c1t0b2tlbkluZGV4XSA9IHRva2VuS2V5c1t0b2tlbkluZGV4XS50cmltKCk7XG4gICAgICAgIGNvbnN0IGRiVmFsID0gcGFyc2VyLmdldF9kYl92YWx1ZV9leHByZXNzaW9uKHNjaGVtYSwgdG9rZW5LZXlzW3Rva2VuSW5kZXhdLCB0b2tlblJlbGF0aW9uVmFsdWVbdG9rZW5JbmRleF0pO1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGRiVmFsKSAmJiBkYlZhbC5xdWVyeV9zZWdtZW50KSB7XG4gICAgICAgICAgdG9rZW5SZWxhdGlvblZhbHVlW3Rva2VuSW5kZXhdID0gZGJWYWwucXVlcnlfc2VnbWVudDtcbiAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdG9rZW5SZWxhdGlvblZhbHVlW3Rva2VuSW5kZXhdID0gZGJWYWw7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgIHRva2VuS2V5cy5qb2luKCdcIixcIicpLCBvcGVyYXRvciwgdG9rZW5SZWxhdGlvblZhbHVlLnRvU3RyaW5nKCksXG4gICAgICApKTtcbiAgICB9IGVsc2Uge1xuICAgICAgYnVpbGRRdWVyeVJlbGF0aW9ucyhmaWVsZE5hbWUsIHRva2VuUmVsYXRpb25WYWx1ZSk7XG4gICAgfVxuICB9O1xuXG4gIGlmIChyZWxhdGlvbktleSA9PT0gJyR0b2tlbicpIHtcbiAgICB3aGVyZVRlbXBsYXRlID0gJ3Rva2VuKFwiJXNcIikgJXMgdG9rZW4oJXMpJztcblxuICAgIGNvbnN0IHRva2VuUmVsYXRpb25LZXlzID0gT2JqZWN0LmtleXMocmVsYXRpb25WYWx1ZSk7XG4gICAgZm9yIChsZXQgdG9rZW5SSyA9IDA7IHRva2VuUksgPCB0b2tlblJlbGF0aW9uS2V5cy5sZW5ndGg7IHRva2VuUksrKykge1xuICAgICAgY29uc3QgdG9rZW5SZWxhdGlvbktleSA9IHRva2VuUmVsYXRpb25LZXlzW3Rva2VuUktdO1xuICAgICAgY29uc3QgdG9rZW5SZWxhdGlvblZhbHVlID0gcmVsYXRpb25WYWx1ZVt0b2tlblJlbGF0aW9uS2V5XTtcbiAgICAgIGJ1aWxkVG9rZW5RdWVyeVJlbGF0aW9ucyh0b2tlblJlbGF0aW9uS2V5LCB0b2tlblJlbGF0aW9uVmFsdWUpO1xuICAgIH1cbiAgfSBlbHNlIGlmIChyZWxhdGlvbktleSA9PT0gJyRjb250YWlucycpIHtcbiAgICBjb25zdCBmaWVsZFR5cGUxID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG4gICAgaWYgKFsnbWFwJywgJ2xpc3QnLCAnc2V0JywgJ2Zyb3plbiddLmluY2x1ZGVzKGZpZWxkVHlwZTEpKSB7XG4gICAgICBpZiAoZmllbGRUeXBlMSA9PT0gJ21hcCcgJiYgXy5pc1BsYWluT2JqZWN0KHJlbGF0aW9uVmFsdWUpKSB7XG4gICAgICAgIE9iamVjdC5rZXlzKHJlbGF0aW9uVmFsdWUpLmZvckVhY2goKGtleSkgPT4ge1xuICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoXG4gICAgICAgICAgICAnXCIlc1wiWyVzXSAlcyAlcycsXG4gICAgICAgICAgICBmaWVsZE5hbWUsICc/JywgJz0nLCAnPycsXG4gICAgICAgICAgKSk7XG4gICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChrZXkpO1xuICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2gocmVsYXRpb25WYWx1ZVtrZXldKTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKFxuICAgICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgICAgZmllbGROYW1lLCBvcGVyYXRvciwgJz8nLFxuICAgICAgICApKTtcbiAgICAgICAgcXVlcnlQYXJhbXMucHVzaChyZWxhdGlvblZhbHVlKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZGNvbnRhaW5zb3AnKSk7XG4gICAgfVxuICB9IGVsc2UgaWYgKHJlbGF0aW9uS2V5ID09PSAnJGNvbnRhaW5zX2tleScpIHtcbiAgICBjb25zdCBmaWVsZFR5cGUyID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG4gICAgaWYgKGZpZWxkVHlwZTIgIT09ICdtYXAnKSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkY29udGFpbnNrZXlvcCcpKTtcbiAgICB9XG4gICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICBmaWVsZE5hbWUsIG9wZXJhdG9yLCAnPycsXG4gICAgKSk7XG4gICAgcXVlcnlQYXJhbXMucHVzaChyZWxhdGlvblZhbHVlKTtcbiAgfSBlbHNlIHtcbiAgICBidWlsZFF1ZXJ5UmVsYXRpb25zKGZpZWxkTmFtZSwgcmVsYXRpb25WYWx1ZSk7XG4gIH1cbiAgcmV0dXJuIHsgcXVlcnlSZWxhdGlvbnMsIHF1ZXJ5UGFyYW1zIH07XG59O1xuXG5wYXJzZXIuX3BhcnNlX3F1ZXJ5X29iamVjdCA9IGZ1bmN0aW9uIGYoc2NoZW1hLCBxdWVyeU9iamVjdCkge1xuICBsZXQgcXVlcnlSZWxhdGlvbnMgPSBbXTtcbiAgbGV0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgT2JqZWN0LmtleXMocXVlcnlPYmplY3QpLmZvckVhY2goKGZpZWxkTmFtZSkgPT4ge1xuICAgIGlmIChmaWVsZE5hbWUuc3RhcnRzV2l0aCgnJCcpKSB7XG4gICAgICAvLyBzZWFyY2ggcXVlcmllcyBiYXNlZCBvbiBsdWNlbmUgaW5kZXggb3Igc29sclxuICAgICAgLy8gZXNjYXBlIGFsbCBzaW5nbGUgcXVvdGVzIGZvciBxdWVyaWVzIGluIGNhc3NhbmRyYVxuICAgICAgaWYgKGZpZWxkTmFtZSA9PT0gJyRleHByJykge1xuICAgICAgICBpZiAodHlwZW9mIHF1ZXJ5T2JqZWN0W2ZpZWxkTmFtZV0uaW5kZXggPT09ICdzdHJpbmcnICYmIHR5cGVvZiBxdWVyeU9iamVjdFtmaWVsZE5hbWVdLnF1ZXJ5ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgICAgICBcImV4cHIoJXMsJyVzJylcIixcbiAgICAgICAgICAgIHF1ZXJ5T2JqZWN0W2ZpZWxkTmFtZV0uaW5kZXgsIHF1ZXJ5T2JqZWN0W2ZpZWxkTmFtZV0ucXVlcnkucmVwbGFjZSgvJy9nLCBcIicnXCIpLFxuICAgICAgICAgICkpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRleHByJykpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkTmFtZSA9PT0gJyRzb2xyX3F1ZXJ5Jykge1xuICAgICAgICBpZiAodHlwZW9mIHF1ZXJ5T2JqZWN0W2ZpZWxkTmFtZV0gPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgIFwic29scl9xdWVyeT0nJXMnXCIsXG4gICAgICAgICAgICBxdWVyeU9iamVjdFtmaWVsZE5hbWVdLnJlcGxhY2UoLycvZywgXCInJ1wiKSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkc29scnF1ZXJ5JykpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbGV0IHdoZXJlT2JqZWN0ID0gcXVlcnlPYmplY3RbZmllbGROYW1lXTtcbiAgICAvLyBBcnJheSBvZiBvcGVyYXRvcnNcbiAgICBpZiAoIV8uaXNBcnJheSh3aGVyZU9iamVjdCkpIHdoZXJlT2JqZWN0ID0gW3doZXJlT2JqZWN0XTtcblxuICAgIGZvciAobGV0IGZrID0gMDsgZmsgPCB3aGVyZU9iamVjdC5sZW5ndGg7IGZrKyspIHtcbiAgICAgIGxldCBmaWVsZFJlbGF0aW9uID0gd2hlcmVPYmplY3RbZmtdO1xuXG4gICAgICBjb25zdCBjcWxPcGVyYXRvcnMgPSB7XG4gICAgICAgICRlcTogJz0nLFxuICAgICAgICAkbmU6ICchPScsXG4gICAgICAgICRpc250OiAnSVMgTk9UJyxcbiAgICAgICAgJGd0OiAnPicsXG4gICAgICAgICRsdDogJzwnLFxuICAgICAgICAkZ3RlOiAnPj0nLFxuICAgICAgICAkbHRlOiAnPD0nLFxuICAgICAgICAkaW46ICdJTicsXG4gICAgICAgICRsaWtlOiAnTElLRScsXG4gICAgICAgICR0b2tlbjogJ3Rva2VuJyxcbiAgICAgICAgJGNvbnRhaW5zOiAnQ09OVEFJTlMnLFxuICAgICAgICAkY29udGFpbnNfa2V5OiAnQ09OVEFJTlMgS0VZJyxcbiAgICAgIH07XG5cbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZmllbGRSZWxhdGlvbikpIHtcbiAgICAgICAgY29uc3QgdmFsaWRLZXlzID0gT2JqZWN0LmtleXMoY3FsT3BlcmF0b3JzKTtcbiAgICAgICAgY29uc3QgZmllbGRSZWxhdGlvbktleXMgPSBPYmplY3Qua2V5cyhmaWVsZFJlbGF0aW9uKTtcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBmaWVsZFJlbGF0aW9uS2V5cy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIGlmICghdmFsaWRLZXlzLmluY2x1ZGVzKGZpZWxkUmVsYXRpb25LZXlzW2ldKSkge1xuICAgICAgICAgICAgLy8gZmllbGQgcmVsYXRpb24ga2V5IGludmFsaWQsIGFwcGx5IGRlZmF1bHQgJGVxIG9wZXJhdG9yXG4gICAgICAgICAgICBmaWVsZFJlbGF0aW9uID0geyAkZXE6IGZpZWxkUmVsYXRpb24gfTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZmllbGRSZWxhdGlvbiA9IHsgJGVxOiBmaWVsZFJlbGF0aW9uIH07XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJlbGF0aW9uS2V5cyA9IE9iamVjdC5rZXlzKGZpZWxkUmVsYXRpb24pO1xuICAgICAgZm9yIChsZXQgcmsgPSAwOyByayA8IHJlbGF0aW9uS2V5cy5sZW5ndGg7IHJrKyspIHtcbiAgICAgICAgY29uc3QgcmVsYXRpb25LZXkgPSByZWxhdGlvbktleXNbcmtdO1xuICAgICAgICBjb25zdCByZWxhdGlvblZhbHVlID0gZmllbGRSZWxhdGlvbltyZWxhdGlvbktleV07XG4gICAgICAgIGNvbnN0IGV4dHJhY3RlZFJlbGF0aW9ucyA9IHBhcnNlci5leHRyYWN0X3F1ZXJ5X3JlbGF0aW9ucyhcbiAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgcmVsYXRpb25LZXksXG4gICAgICAgICAgcmVsYXRpb25WYWx1ZSxcbiAgICAgICAgICBzY2hlbWEsXG4gICAgICAgICAgY3FsT3BlcmF0b3JzLFxuICAgICAgICApO1xuICAgICAgICBxdWVyeVJlbGF0aW9ucyA9IHF1ZXJ5UmVsYXRpb25zLmNvbmNhdChleHRyYWN0ZWRSZWxhdGlvbnMucXVlcnlSZWxhdGlvbnMpO1xuICAgICAgICBxdWVyeVBhcmFtcyA9IHF1ZXJ5UGFyYW1zLmNvbmNhdChleHRyYWN0ZWRSZWxhdGlvbnMucXVlcnlQYXJhbXMpO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHsgcXVlcnlSZWxhdGlvbnMsIHF1ZXJ5UGFyYW1zIH07XG59O1xuXG5wYXJzZXIuZ2V0X2ZpbHRlcl9jbGF1c2UgPSBmdW5jdGlvbiBmKHNjaGVtYSwgcXVlcnlPYmplY3QsIGNsYXVzZSkge1xuICBjb25zdCBwYXJzZWRPYmplY3QgPSBwYXJzZXIuX3BhcnNlX3F1ZXJ5X29iamVjdChzY2hlbWEsIHF1ZXJ5T2JqZWN0KTtcbiAgY29uc3QgZmlsdGVyQ2xhdXNlID0ge307XG4gIGlmIChwYXJzZWRPYmplY3QucXVlcnlSZWxhdGlvbnMubGVuZ3RoID4gMCkge1xuICAgIGZpbHRlckNsYXVzZS5xdWVyeSA9IHV0aWwuZm9ybWF0KCclcyAlcycsIGNsYXVzZSwgcGFyc2VkT2JqZWN0LnF1ZXJ5UmVsYXRpb25zLmpvaW4oJyBBTkQgJykpO1xuICB9IGVsc2Uge1xuICAgIGZpbHRlckNsYXVzZS5xdWVyeSA9ICcnO1xuICB9XG4gIGZpbHRlckNsYXVzZS5wYXJhbXMgPSBwYXJzZWRPYmplY3QucXVlcnlQYXJhbXM7XG4gIHJldHVybiBmaWx0ZXJDbGF1c2U7XG59O1xuXG5wYXJzZXIuZ2V0X2ZpbHRlcl9jbGF1c2VfZGRsID0gZnVuY3Rpb24gZihzY2hlbWEsIHF1ZXJ5T2JqZWN0LCBjbGF1c2UpIHtcbiAgY29uc3QgZmlsdGVyQ2xhdXNlID0gcGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlKHNjaGVtYSwgcXVlcnlPYmplY3QsIGNsYXVzZSk7XG4gIGxldCBmaWx0ZXJRdWVyeSA9IGZpbHRlckNsYXVzZS5xdWVyeTtcbiAgZmlsdGVyQ2xhdXNlLnBhcmFtcy5mb3JFYWNoKChwYXJhbSkgPT4ge1xuICAgIGxldCBxdWVyeVBhcmFtO1xuICAgIGlmICh0eXBlb2YgcGFyYW0gPT09ICdzdHJpbmcnKSB7XG4gICAgICBxdWVyeVBhcmFtID0gdXRpbC5mb3JtYXQoXCInJXMnXCIsIHBhcmFtKTtcbiAgICB9IGVsc2UgaWYgKHBhcmFtIGluc3RhbmNlb2YgRGF0ZSkge1xuICAgICAgcXVlcnlQYXJhbSA9IHV0aWwuZm9ybWF0KFwiJyVzJ1wiLCBwYXJhbS50b0lTT1N0cmluZygpKTtcbiAgICB9IGVsc2UgaWYgKHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLkxvbmdcbiAgICAgIHx8IHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLkludGVnZXJcbiAgICAgIHx8IHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLkJpZ0RlY2ltYWxcbiAgICAgIHx8IHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLlRpbWVVdWlkXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5VdWlkKSB7XG4gICAgICBxdWVyeVBhcmFtID0gcGFyYW0udG9TdHJpbmcoKTtcbiAgICB9IGVsc2UgaWYgKHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLkxvY2FsRGF0ZVxuICAgICAgfHwgcGFyYW0gaW5zdGFuY2VvZiBjcWwudHlwZXMuTG9jYWxUaW1lXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5JbmV0QWRkcmVzcykge1xuICAgICAgcXVlcnlQYXJhbSA9IHV0aWwuZm9ybWF0KFwiJyVzJ1wiLCBwYXJhbS50b1N0cmluZygpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcXVlcnlQYXJhbSA9IHBhcmFtO1xuICAgIH1cbiAgICAvLyBUT0RPOiB1bmhhbmRsZWQgaWYgcXVlcnlQYXJhbSBpcyBhIHN0cmluZyBjb250YWluaW5nID8gY2hhcmFjdGVyXG4gICAgLy8gdGhvdWdoIHRoaXMgaXMgdW5saWtlbHkgdG8gaGF2ZSBpbiBtYXRlcmlhbGl6ZWQgdmlldyBmaWx0ZXJzLCBidXQuLi5cbiAgICBmaWx0ZXJRdWVyeSA9IGZpbHRlclF1ZXJ5LnJlcGxhY2UoJz8nLCBxdWVyeVBhcmFtKTtcbiAgfSk7XG4gIHJldHVybiBmaWx0ZXJRdWVyeTtcbn07XG5cbnBhcnNlci5nZXRfd2hlcmVfY2xhdXNlID0gZnVuY3Rpb24gZihzY2hlbWEsIHF1ZXJ5T2JqZWN0KSB7XG4gIHJldHVybiBwYXJzZXIuZ2V0X2ZpbHRlcl9jbGF1c2Uoc2NoZW1hLCBxdWVyeU9iamVjdCwgJ1dIRVJFJyk7XG59O1xuXG5wYXJzZXIuZ2V0X2lmX2NsYXVzZSA9IGZ1bmN0aW9uIGYoc2NoZW1hLCBxdWVyeU9iamVjdCkge1xuICByZXR1cm4gcGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlKHNjaGVtYSwgcXVlcnlPYmplY3QsICdJRicpO1xufTtcblxucGFyc2VyLmdldF9wcmltYXJ5X2tleV9jbGF1c2VzID0gZnVuY3Rpb24gZihzY2hlbWEpIHtcbiAgY29uc3QgcGFydGl0aW9uS2V5ID0gc2NoZW1hLmtleVswXTtcbiAgbGV0IGNsdXN0ZXJpbmdLZXkgPSBzY2hlbWEua2V5LnNsaWNlKDEsIHNjaGVtYS5rZXkubGVuZ3RoKTtcbiAgY29uc3QgY2x1c3RlcmluZ09yZGVyID0gW107XG5cbiAgZm9yIChsZXQgZmllbGQgPSAwOyBmaWVsZCA8IGNsdXN0ZXJpbmdLZXkubGVuZ3RoOyBmaWVsZCsrKSB7XG4gICAgaWYgKHNjaGVtYS5jbHVzdGVyaW5nX29yZGVyXG4gICAgICAgICYmIHNjaGVtYS5jbHVzdGVyaW5nX29yZGVyW2NsdXN0ZXJpbmdLZXlbZmllbGRdXVxuICAgICAgICAmJiBzY2hlbWEuY2x1c3RlcmluZ19vcmRlcltjbHVzdGVyaW5nS2V5W2ZpZWxkXV0udG9Mb3dlckNhc2UoKSA9PT0gJ2Rlc2MnKSB7XG4gICAgICBjbHVzdGVyaW5nT3JkZXIucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiIERFU0MnLCBjbHVzdGVyaW5nS2V5W2ZpZWxkXSkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjbHVzdGVyaW5nT3JkZXIucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiIEFTQycsIGNsdXN0ZXJpbmdLZXlbZmllbGRdKSk7XG4gICAgfVxuICB9XG5cbiAgbGV0IGNsdXN0ZXJpbmdPcmRlckNsYXVzZSA9ICcnO1xuICBpZiAoY2x1c3RlcmluZ09yZGVyLmxlbmd0aCA+IDApIHtcbiAgICBjbHVzdGVyaW5nT3JkZXJDbGF1c2UgPSB1dGlsLmZvcm1hdCgnIFdJVEggQ0xVU1RFUklORyBPUkRFUiBCWSAoJXMpJywgY2x1c3RlcmluZ09yZGVyLnRvU3RyaW5nKCkpO1xuICB9XG5cbiAgbGV0IHBhcnRpdGlvbktleUNsYXVzZSA9ICcnO1xuICBpZiAoXy5pc0FycmF5KHBhcnRpdGlvbktleSkpIHtcbiAgICBwYXJ0aXRpb25LZXlDbGF1c2UgPSBwYXJ0aXRpb25LZXkubWFwKCh2KSA9PiBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiJywgdikpLmpvaW4oJywnKTtcbiAgfSBlbHNlIHtcbiAgICBwYXJ0aXRpb25LZXlDbGF1c2UgPSBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiJywgcGFydGl0aW9uS2V5KTtcbiAgfVxuXG4gIGxldCBjbHVzdGVyaW5nS2V5Q2xhdXNlID0gJyc7XG4gIGlmIChjbHVzdGVyaW5nS2V5Lmxlbmd0aCkge1xuICAgIGNsdXN0ZXJpbmdLZXkgPSBjbHVzdGVyaW5nS2V5Lm1hcCgodikgPT4gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHYpKS5qb2luKCcsJyk7XG4gICAgY2x1c3RlcmluZ0tleUNsYXVzZSA9IHV0aWwuZm9ybWF0KCcsJXMnLCBjbHVzdGVyaW5nS2V5KTtcbiAgfVxuXG4gIHJldHVybiB7IHBhcnRpdGlvbktleUNsYXVzZSwgY2x1c3RlcmluZ0tleUNsYXVzZSwgY2x1c3RlcmluZ09yZGVyQ2xhdXNlIH07XG59O1xuXG5wYXJzZXIuZ2V0X212aWV3X3doZXJlX2NsYXVzZSA9IGZ1bmN0aW9uIGYoc2NoZW1hLCB2aWV3U2NoZW1hKSB7XG4gIGNvbnN0IGNsYXVzZXMgPSBwYXJzZXIuZ2V0X3ByaW1hcnlfa2V5X2NsYXVzZXModmlld1NjaGVtYSk7XG4gIGxldCB3aGVyZUNsYXVzZSA9IGNsYXVzZXMucGFydGl0aW9uS2V5Q2xhdXNlLnNwbGl0KCcsJykuam9pbignIElTIE5PVCBOVUxMIEFORCAnKTtcbiAgaWYgKGNsYXVzZXMuY2x1c3RlcmluZ0tleUNsYXVzZSkgd2hlcmVDbGF1c2UgKz0gY2xhdXNlcy5jbHVzdGVyaW5nS2V5Q2xhdXNlLnNwbGl0KCcsJykuam9pbignIElTIE5PVCBOVUxMIEFORCAnKTtcbiAgd2hlcmVDbGF1c2UgKz0gJyBJUyBOT1QgTlVMTCc7XG5cbiAgY29uc3QgZmlsdGVycyA9IF8uY2xvbmVEZWVwKHZpZXdTY2hlbWEuZmlsdGVycyk7XG5cbiAgaWYgKF8uaXNQbGFpbk9iamVjdChmaWx0ZXJzKSkge1xuICAgIC8vIGRlbGV0ZSBwcmltYXJ5IGtleSBmaWVsZHMgZGVmaW5lZCBhcyBpc24ndCBudWxsIGluIGZpbHRlcnNcbiAgICBPYmplY3Qua2V5cyhmaWx0ZXJzKS5mb3JFYWNoKChmaWx0ZXJLZXkpID0+IHtcbiAgICAgIGlmIChmaWx0ZXJzW2ZpbHRlcktleV0uJGlzbnQgPT09IG51bGxcbiAgICAgICAgICAmJiAodmlld1NjaGVtYS5rZXkuaW5jbHVkZXMoZmlsdGVyS2V5KSB8fCB2aWV3U2NoZW1hLmtleVswXS5pbmNsdWRlcyhmaWx0ZXJLZXkpKSkge1xuICAgICAgICBkZWxldGUgZmlsdGVyc1tmaWx0ZXJLZXldLiRpc250O1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgY29uc3QgZmlsdGVyQ2xhdXNlID0gcGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlX2RkbChzY2hlbWEsIGZpbHRlcnMsICdBTkQnKTtcbiAgICB3aGVyZUNsYXVzZSArPSB1dGlsLmZvcm1hdCgnICVzJywgZmlsdGVyQ2xhdXNlKS5yZXBsYWNlKC9JUyBOT1QgbnVsbC9nLCAnSVMgTk9UIE5VTEwnKTtcbiAgfVxuXG4gIC8vIHJlbW92ZSB1bm5lY2Vzc2FyaWx5IHF1b3RlZCBmaWVsZCBuYW1lcyBpbiBnZW5lcmF0ZWQgd2hlcmUgY2xhdXNlXG4gIC8vIHNvIHRoYXQgaXQgbWF0Y2hlcyB0aGUgd2hlcmVfY2xhdXNlIGZyb20gZGF0YWJhc2Ugc2NoZW1hXG4gIGNvbnN0IHF1b3RlZEZpZWxkTmFtZXMgPSB3aGVyZUNsYXVzZS5tYXRjaCgvXCIoLio/KVwiL2cpO1xuICBxdW90ZWRGaWVsZE5hbWVzLmZvckVhY2goKGZpZWxkTmFtZSkgPT4ge1xuICAgIGNvbnN0IHVucXVvdGVkRmllbGROYW1lID0gZmllbGROYW1lLnJlcGxhY2UoL1wiL2csICcnKTtcbiAgICBjb25zdCByZXNlcnZlZEtleXdvcmRzID0gW1xuICAgICAgJ0FERCcsICdBR0dSRUdBVEUnLCAnQUxMT1cnLCAnQUxURVInLCAnQU5EJywgJ0FOWScsICdBUFBMWScsXG4gICAgICAnQVNDJywgJ0FVVEhPUklaRScsICdCQVRDSCcsICdCRUdJTicsICdCWScsICdDT0xVTU5GQU1JTFknLFxuICAgICAgJ0NSRUFURScsICdERUxFVEUnLCAnREVTQycsICdEUk9QJywgJ0VBQ0hfUVVPUlVNJywgJ0VOVFJJRVMnLFxuICAgICAgJ0ZST00nLCAnRlVMTCcsICdHUkFOVCcsICdJRicsICdJTicsICdJTkRFWCcsICdJTkVUJywgJ0lORklOSVRZJyxcbiAgICAgICdJTlNFUlQnLCAnSU5UTycsICdLRVlTUEFDRScsICdLRVlTUEFDRVMnLCAnTElNSVQnLCAnTE9DQUxfT05FJyxcbiAgICAgICdMT0NBTF9RVU9SVU0nLCAnTUFURVJJQUxJWkVEJywgJ01PRElGWScsICdOQU4nLCAnTk9SRUNVUlNJVkUnLFxuICAgICAgJ05PVCcsICdPRicsICdPTicsICdPTkUnLCAnT1JERVInLCAnUEFSVElUSU9OJywgJ1BBU1NXT1JEJywgJ1BFUicsXG4gICAgICAnUFJJTUFSWScsICdRVU9SVU0nLCAnUkVOQU1FJywgJ1JFVk9LRScsICdTQ0hFTUEnLCAnU0VMRUNUJywgJ1NFVCcsXG4gICAgICAnVEFCTEUnLCAnVElNRScsICdUSFJFRScsICdUTycsICdUT0tFTicsICdUUlVOQ0FURScsICdUV08nLCAnVU5MT0dHRUQnLFxuICAgICAgJ1VQREFURScsICdVU0UnLCAnVVNJTkcnLCAnVklFVycsICdXSEVSRScsICdXSVRIJ107XG4gICAgaWYgKHVucXVvdGVkRmllbGROYW1lID09PSB1bnF1b3RlZEZpZWxkTmFtZS50b0xvd2VyQ2FzZSgpXG4gICAgICAmJiAhcmVzZXJ2ZWRLZXl3b3Jkcy5pbmNsdWRlcyh1bnF1b3RlZEZpZWxkTmFtZS50b1VwcGVyQ2FzZSgpKSkge1xuICAgICAgd2hlcmVDbGF1c2UgPSB3aGVyZUNsYXVzZS5yZXBsYWNlKGZpZWxkTmFtZSwgdW5xdW90ZWRGaWVsZE5hbWUpO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiB3aGVyZUNsYXVzZTtcbn07XG5cbnBhcnNlci5nZXRfb3JkZXJieV9jbGF1c2UgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0KSB7XG4gIGNvbnN0IG9yZGVyS2V5cyA9IFtdO1xuICBPYmplY3Qua2V5cyhxdWVyeU9iamVjdCkuZm9yRWFjaCgoaykgPT4ge1xuICAgIGNvbnN0IHF1ZXJ5SXRlbSA9IHF1ZXJ5T2JqZWN0W2tdO1xuICAgIGlmIChrLnRvTG93ZXJDYXNlKCkgPT09ICckb3JkZXJieScpIHtcbiAgICAgIGlmICghKHF1ZXJ5SXRlbSBpbnN0YW5jZW9mIE9iamVjdCkpIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZG9yZGVyJykpO1xuICAgICAgfVxuICAgICAgY29uc3Qgb3JkZXJJdGVtS2V5cyA9IE9iamVjdC5rZXlzKHF1ZXJ5SXRlbSk7XG5cbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgb3JkZXJJdGVtS2V5cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCBjcWxPcmRlckRpcmVjdGlvbiA9IHsgJGFzYzogJ0FTQycsICRkZXNjOiAnREVTQycgfTtcbiAgICAgICAgaWYgKG9yZGVySXRlbUtleXNbaV0udG9Mb3dlckNhc2UoKSBpbiBjcWxPcmRlckRpcmVjdGlvbikge1xuICAgICAgICAgIGxldCBvcmRlckZpZWxkcyA9IHF1ZXJ5SXRlbVtvcmRlckl0ZW1LZXlzW2ldXTtcblxuICAgICAgICAgIGlmICghXy5pc0FycmF5KG9yZGVyRmllbGRzKSkge1xuICAgICAgICAgICAgb3JkZXJGaWVsZHMgPSBbb3JkZXJGaWVsZHNdO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGZvciAobGV0IGogPSAwOyBqIDwgb3JkZXJGaWVsZHMubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgICAgIG9yZGVyS2V5cy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKFxuICAgICAgICAgICAgICAnXCIlc1wiICVzJyxcbiAgICAgICAgICAgICAgb3JkZXJGaWVsZHNbal0sIGNxbE9yZGVyRGlyZWN0aW9uW29yZGVySXRlbUtleXNbaV1dLFxuICAgICAgICAgICAgKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRvcmRlcnR5cGUnLCBvcmRlckl0ZW1LZXlzW2ldKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuICByZXR1cm4gb3JkZXJLZXlzLmxlbmd0aCA/IHV0aWwuZm9ybWF0KCdPUkRFUiBCWSAlcycsIG9yZGVyS2V5cy5qb2luKCcsICcpKSA6ICcgJztcbn07XG5cbnBhcnNlci5nZXRfZ3JvdXBieV9jbGF1c2UgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0KSB7XG4gIGxldCBncm91cGJ5S2V5cyA9IFtdO1xuXG4gIE9iamVjdC5rZXlzKHF1ZXJ5T2JqZWN0KS5mb3JFYWNoKChrKSA9PiB7XG4gICAgY29uc3QgcXVlcnlJdGVtID0gcXVlcnlPYmplY3Rba107XG5cbiAgICBpZiAoay50b0xvd2VyQ2FzZSgpID09PSAnJGdyb3VwYnknKSB7XG4gICAgICBpZiAoIShxdWVyeUl0ZW0gaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZGdyb3VwJykpO1xuICAgICAgfVxuXG4gICAgICBncm91cGJ5S2V5cyA9IGdyb3VwYnlLZXlzLmNvbmNhdChxdWVyeUl0ZW0pO1xuICAgIH1cbiAgfSk7XG5cbiAgZ3JvdXBieUtleXMgPSBncm91cGJ5S2V5cy5tYXAoKGtleSkgPT4gYFwiJHtrZXl9XCJgKTtcblxuICByZXR1cm4gZ3JvdXBieUtleXMubGVuZ3RoID8gdXRpbC5mb3JtYXQoJ0dST1VQIEJZICVzJywgZ3JvdXBieUtleXMuam9pbignLCAnKSkgOiAnICc7XG59O1xuXG5wYXJzZXIuZ2V0X2xpbWl0X2NsYXVzZSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QpIHtcbiAgbGV0IGxpbWl0ID0gbnVsbDtcbiAgT2JqZWN0LmtleXMocXVlcnlPYmplY3QpLmZvckVhY2goKGspID0+IHtcbiAgICBjb25zdCBxdWVyeUl0ZW0gPSBxdWVyeU9iamVjdFtrXTtcbiAgICBpZiAoay50b0xvd2VyQ2FzZSgpID09PSAnJGxpbWl0Jykge1xuICAgICAgaWYgKHR5cGVvZiBxdWVyeUl0ZW0gIT09ICdudW1iZXInKSB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5saW1pdHR5cGUnKSk7XG4gICAgICBsaW1pdCA9IHF1ZXJ5SXRlbTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gbGltaXQgPyB1dGlsLmZvcm1hdCgnTElNSVQgJXMnLCBsaW1pdCkgOiAnICc7XG59O1xuXG5wYXJzZXIuZ2V0X3NlbGVjdF9jbGF1c2UgPSBmdW5jdGlvbiBmKG9wdGlvbnMpIHtcbiAgbGV0IHNlbGVjdENsYXVzZSA9ICcqJztcbiAgaWYgKG9wdGlvbnMuc2VsZWN0ICYmIF8uaXNBcnJheShvcHRpb25zLnNlbGVjdCkgJiYgb3B0aW9ucy5zZWxlY3QubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHNlbGVjdEFycmF5ID0gW107XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvcHRpb25zLnNlbGVjdC5sZW5ndGg7IGkrKykge1xuICAgICAgLy8gc2VwYXJhdGUgdGhlIGFnZ3JlZ2F0ZSBmdW5jdGlvbiBhbmQgdGhlIGNvbHVtbiBuYW1lIGlmIHNlbGVjdCBpcyBhbiBhZ2dyZWdhdGUgZnVuY3Rpb25cbiAgICAgIGNvbnN0IHNlbGVjdGlvbiA9IG9wdGlvbnMuc2VsZWN0W2ldLnNwbGl0KC9bKCwgKV0vZykuZmlsdGVyKChlKSA9PiAoZSkpO1xuICAgICAgaWYgKHNlbGVjdGlvbi5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgaWYgKHNlbGVjdGlvblswXSA9PT0gJyonKSBzZWxlY3RBcnJheS5wdXNoKCcqJyk7XG4gICAgICAgIGVsc2Ugc2VsZWN0QXJyYXkucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiJywgc2VsZWN0aW9uWzBdKSk7XG4gICAgICB9IGVsc2UgaWYgKHNlbGVjdGlvbi5sZW5ndGggPT09IDIpIHtcbiAgICAgICAgc2VsZWN0QXJyYXkucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnJXMoXCIlc1wiKScsIHNlbGVjdGlvblswXSwgc2VsZWN0aW9uWzFdKSk7XG4gICAgICB9IGVsc2UgaWYgKHNlbGVjdGlvbi5sZW5ndGggPj0gMyAmJiBzZWxlY3Rpb25bc2VsZWN0aW9uLmxlbmd0aCAtIDJdLnRvTG93ZXJDYXNlKCkgPT09ICdhcycpIHtcbiAgICAgICAgY29uc3Qgc2VsZWN0aW9uRW5kQ2h1bmsgPSBzZWxlY3Rpb24uc3BsaWNlKHNlbGVjdGlvbi5sZW5ndGggLSAyKTtcbiAgICAgICAgbGV0IHNlbGVjdGlvbkNodW5rID0gJyc7XG4gICAgICAgIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAxKSB7XG4gICAgICAgICAgc2VsZWN0aW9uQ2h1bmsgPSBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiJywgc2VsZWN0aW9uWzBdKTtcbiAgICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAyKSB7XG4gICAgICAgICAgc2VsZWN0aW9uQ2h1bmsgPSBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnJXMoXCIlc1wiKScsIHNlbGVjdGlvblswXSwgc2VsZWN0aW9uWzFdKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBzZWxlY3Rpb25DaHVuayA9IHV0aWwuZm9ybWF0KCclcyglcyknLCBzZWxlY3Rpb25bMF0sIGBcIiR7c2VsZWN0aW9uLnNwbGljZSgxKS5qb2luKCdcIixcIicpfVwiYCk7XG4gICAgICAgIH1cbiAgICAgICAgc2VsZWN0QXJyYXkucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnJXMgQVMgXCIlc1wiJywgc2VsZWN0aW9uQ2h1bmssIHNlbGVjdGlvbkVuZENodW5rWzFdKSk7XG4gICAgICB9IGVsc2UgaWYgKHNlbGVjdGlvbi5sZW5ndGggPj0gMykge1xuICAgICAgICBzZWxlY3RBcnJheS5wdXNoKHV0aWwuZm9ybWF0KCclcyglcyknLCBzZWxlY3Rpb25bMF0sIGBcIiR7c2VsZWN0aW9uLnNwbGljZSgxKS5qb2luKCdcIixcIicpfVwiYCkpO1xuICAgICAgfVxuICAgIH1cbiAgICBzZWxlY3RDbGF1c2UgPSBzZWxlY3RBcnJheS5qb2luKCcsJyk7XG4gIH1cbiAgcmV0dXJuIHNlbGVjdENsYXVzZTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gcGFyc2VyO1xuIl19