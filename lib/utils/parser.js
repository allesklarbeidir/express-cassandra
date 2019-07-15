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
      if (typeof fieldValue === "string") {
        return util.format("'%s'", fieldValue);
      } else {
        return util.format("'%s'", JSON.stringify(fieldValue));
      }
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9wYXJzZXIuanMiXSwibmFtZXMiOlsiUHJvbWlzZSIsInJlcXVpcmUiLCJfIiwidXRpbCIsImRzZURyaXZlciIsImUiLCJjcWwiLCJwcm9taXNpZnlBbGwiLCJidWlsZEVycm9yIiwiZGF0YXR5cGVzIiwic2NoZW1lciIsInBhcnNlciIsInNldENoYXJBdCIsInN0ciIsImluZGV4IiwiY2hyIiwic3Vic3RyIiwiZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSIsImYiLCJmb3JtYXRTdHJpbmciLCJwbGFjZWhvbGRlcnMiLCJyZSIsIm1hdGNoIiwiZXhlYyIsInB1c2giLCJwYXJhbXMiLCJmb3JFYWNoIiwicCIsImkiLCJsZW5ndGgiLCJpbmRleE9mIiwiZnAiLCJmb3JtYXQiLCJkYl92YWx1ZV93aXRob3V0X2JpbmRfZm9yX0pTT05CX1lDUUxfQnVnIiwic2NoZW1hIiwiZmllbGROYW1lIiwiZmllbGRWYWx1ZSIsImlzSnNvbmJBdHRyIiwiZmllbGROYW1lUm9vdCIsInJlcGxhY2UiLCJmaWVsZFJvb3RUeXBlIiwiZmllbGRzIiwidHlwZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJjYWxsYmFja19vcl90aHJvdyIsImVyciIsImNhbGxiYWNrIiwiZXh0cmFjdF90eXBlIiwidmFsIiwiZGVjb21wb3NlZCIsInNwbGl0IiwiZCIsImhhcyIsImV4dHJhY3RfdHlwZURlZiIsImV4dHJhY3RfYWx0ZXJlZF90eXBlIiwibm9ybWFsaXplZE1vZGVsU2NoZW1hIiwiZGlmZiIsInBhdGgiLCJyaHMiLCJ0eXBlRGVmIiwiZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24iLCJ0eXBlcyIsInVuc2V0IiwicXVlcnlfc2VnbWVudCIsInBhcmFtZXRlciIsImlzUGxhaW5PYmplY3QiLCIkZGJfZnVuY3Rpb24iLCJmaWVsZFR5cGUiLCJnZXRfZmllbGRfdHlwZSIsInZhbGlkYXRvcnMiLCJnZXRfdmFsaWRhdG9ycyIsImlzQXJyYXkiLCJtYXAiLCJ2IiwiZGJWYWwiLCJqc29uYlVuYmluZGVkQmVjYXVzZU9mQnVnIiwidmFsaWRhdGlvbk1lc3NhZ2UiLCJnZXRfdmFsaWRhdGlvbl9tZXNzYWdlIiwiY291bnRlclF1ZXJ5U2VnbWVudCIsIk1hdGgiLCJhYnMiLCJ1bnNldF9ub3RfYWxsb3dlZCIsIm9wZXJhdGlvbiIsImlzX3ByaW1hcnlfa2V5X2ZpZWxkIiwiaXNfcmVxdWlyZWRfZmllbGQiLCJnZXRfaW5wbGFjZV91cGRhdGVfZXhwcmVzc2lvbiIsInVwZGF0ZUNsYXVzZXMiLCJxdWVyeVBhcmFtcyIsIiRhZGQiLCIkYXBwZW5kIiwiJHByZXBlbmQiLCIkcmVwbGFjZSIsIiRyZW1vdmUiLCJpbmNsdWRlcyIsIk9iamVjdCIsImtleXMiLCJyZXBsYWNlS2V5cyIsInJlcGxhY2VWYWx1ZXMiLCJ2YWx1ZXMiLCJnZXRfdXBkYXRlX3ZhbHVlX2V4cHJlc3Npb24iLCJpbnN0YW5jZSIsInVwZGF0ZVZhbHVlcyIsIm9wdGlvbnMiLCJ0aW1lc3RhbXBzIiwidXBkYXRlZEF0IiwidmVyc2lvbnMiLCJrZXkiLCJlcnJvckhhcHBlbmVkIiwic29tZSIsInVuZGVmaW5lZCIsInZpcnR1YWwiLCJfZ2V0X2RlZmF1bHRfdmFsdWUiLCJydWxlIiwiaWdub3JlX2RlZmF1bHQiLCJ2YWxpZGF0ZSIsImdldF9zYXZlX3ZhbHVlX2V4cHJlc3Npb24iLCJmbiIsImlkZW50aWZpZXJzIiwiZXh0cmFjdF9xdWVyeV9yZWxhdGlvbnMiLCJyZWxhdGlvbktleSIsInJlbGF0aW9uVmFsdWUiLCJ2YWxpZE9wZXJhdG9ycyIsInF1ZXJ5UmVsYXRpb25zIiwidG9Mb3dlckNhc2UiLCJvcGVyYXRvciIsIndoZXJlVGVtcGxhdGUiLCJidWlsZFF1ZXJ5UmVsYXRpb25zIiwiZmllbGROYW1lTG9jYWwiLCJyZWxhdGlvblZhbHVlTG9jYWwiLCJidWlsZFRva2VuUXVlcnlSZWxhdGlvbnMiLCJ0b2tlblJlbGF0aW9uS2V5IiwidG9rZW5SZWxhdGlvblZhbHVlIiwidG9rZW5LZXlzIiwidG9rZW5JbmRleCIsInRyaW0iLCJqb2luIiwidG9TdHJpbmciLCJ0b2tlblJlbGF0aW9uS2V5cyIsInRva2VuUksiLCJmaWVsZFR5cGUxIiwiZmllbGRUeXBlMiIsIl9wYXJzZV9xdWVyeV9vYmplY3QiLCJxdWVyeU9iamVjdCIsInN0YXJ0c1dpdGgiLCJxdWVyeSIsIndoZXJlT2JqZWN0IiwiZmsiLCJmaWVsZFJlbGF0aW9uIiwiY3FsT3BlcmF0b3JzIiwiJGVxIiwiJG5lIiwiJGlzbnQiLCIkZ3QiLCIkbHQiLCIkZ3RlIiwiJGx0ZSIsIiRpbiIsIiRsaWtlIiwiJHRva2VuIiwiJGNvbnRhaW5zIiwiJGNvbnRhaW5zX2tleSIsInZhbGlkS2V5cyIsImZpZWxkUmVsYXRpb25LZXlzIiwicmVsYXRpb25LZXlzIiwicmsiLCJleHRyYWN0ZWRSZWxhdGlvbnMiLCJjb25jYXQiLCJnZXRfZmlsdGVyX2NsYXVzZSIsImNsYXVzZSIsInBhcnNlZE9iamVjdCIsImZpbHRlckNsYXVzZSIsImdldF9maWx0ZXJfY2xhdXNlX2RkbCIsImZpbHRlclF1ZXJ5IiwicGFyYW0iLCJxdWVyeVBhcmFtIiwiRGF0ZSIsInRvSVNPU3RyaW5nIiwiTG9uZyIsIkludGVnZXIiLCJCaWdEZWNpbWFsIiwiVGltZVV1aWQiLCJVdWlkIiwiTG9jYWxEYXRlIiwiTG9jYWxUaW1lIiwiSW5ldEFkZHJlc3MiLCJnZXRfd2hlcmVfY2xhdXNlIiwiZ2V0X2lmX2NsYXVzZSIsImdldF9wcmltYXJ5X2tleV9jbGF1c2VzIiwicGFydGl0aW9uS2V5IiwiY2x1c3RlcmluZ0tleSIsInNsaWNlIiwiY2x1c3RlcmluZ09yZGVyIiwiZmllbGQiLCJjbHVzdGVyaW5nX29yZGVyIiwiY2x1c3RlcmluZ09yZGVyQ2xhdXNlIiwicGFydGl0aW9uS2V5Q2xhdXNlIiwiY2x1c3RlcmluZ0tleUNsYXVzZSIsImdldF9tdmlld193aGVyZV9jbGF1c2UiLCJ2aWV3U2NoZW1hIiwiY2xhdXNlcyIsIndoZXJlQ2xhdXNlIiwiZmlsdGVycyIsImNsb25lRGVlcCIsImZpbHRlcktleSIsInF1b3RlZEZpZWxkTmFtZXMiLCJ1bnF1b3RlZEZpZWxkTmFtZSIsInJlc2VydmVkS2V5d29yZHMiLCJ0b1VwcGVyQ2FzZSIsImdldF9vcmRlcmJ5X2NsYXVzZSIsIm9yZGVyS2V5cyIsImsiLCJxdWVyeUl0ZW0iLCJvcmRlckl0ZW1LZXlzIiwiY3FsT3JkZXJEaXJlY3Rpb24iLCIkYXNjIiwiJGRlc2MiLCJvcmRlckZpZWxkcyIsImoiLCJnZXRfZ3JvdXBieV9jbGF1c2UiLCJncm91cGJ5S2V5cyIsIkFycmF5IiwiZ2V0X2xpbWl0X2NsYXVzZSIsImxpbWl0IiwiZ2V0X3NlbGVjdF9jbGF1c2UiLCJzZWxlY3RDbGF1c2UiLCJzZWxlY3QiLCJzZWxlY3RBcnJheSIsInNlbGVjdGlvbiIsImZpbHRlciIsInNlbGVjdGlvbkVuZENodW5rIiwic3BsaWNlIiwic2VsZWN0aW9uQ2h1bmsiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOztBQUFBLElBQU1BLFVBQVVDLFFBQVEsVUFBUixDQUFoQjtBQUNBLElBQU1DLElBQUlELFFBQVEsUUFBUixDQUFWO0FBQ0EsSUFBTUUsT0FBT0YsUUFBUSxNQUFSLENBQWI7O0FBRUEsSUFBSUcsa0JBQUo7QUFDQSxJQUFJO0FBQ0Y7QUFDQUEsY0FBWUgsUUFBUSxZQUFSLENBQVo7QUFDRCxDQUhELENBR0UsT0FBT0ksQ0FBUCxFQUFVO0FBQ1ZELGNBQVksSUFBWjtBQUNEOztBQUVELElBQU1FLE1BQU1OLFFBQVFPLFlBQVIsQ0FBcUJILGFBQWFILFFBQVEsa0JBQVIsQ0FBbEMsQ0FBWjs7QUFFQSxJQUFNTyxhQUFhUCxRQUFRLHdCQUFSLENBQW5CO0FBQ0EsSUFBTVEsWUFBWVIsUUFBUSx5QkFBUixDQUFsQjtBQUNBLElBQU1TLFVBQVVULFFBQVEsc0JBQVIsQ0FBaEI7O0FBRUEsSUFBTVUsU0FBUyxFQUFmO0FBQ0EsSUFBTUMsWUFBWSxTQUFaQSxTQUFZLENBQUNDLEdBQUQsRUFBS0MsS0FBTCxFQUFZQyxHQUFaO0FBQUEsU0FBb0JGLElBQUlHLE1BQUos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RUFBNEI7QUFDakMyTSwyQkFBaUI3TixPQUFPTSxzQkFBUCxDQUE4QixVQUE5QixFQUEwQ21OLFVBQVUsQ0FBVixDQUExQyxFQUF3REEsVUFBVSxDQUFWLENBQXhELENBQWpCO0FBQ0QsU0FGTSxNQUVBO0FBQ0xJLDJCQUFpQnJPLEtBQUs2QixNQUFMLENBQVksUUFBWixFQUFzQm9NLFVBQVUsQ0FBVixDQUF0QixFQUFxQyxJQUFHQSxVQUFVRyxNQUFWLENBQWlCLENBQWpCLEVBQW9CL0YsSUFBcEIsQ0FBeUIsS0FBekIsQ0FBZ0MsR0FBeEUsQ0FBakI7QUFDRDtBQUNEMkYsb0JBQVkzTSxJQUFaLENBQWlCYixPQUFPTSxzQkFBUCxDQUE4QixZQUE5QixFQUE0Q3VOLGNBQTVDLEVBQTRERixrQkFBa0IsQ0FBbEIsQ0FBNUQsQ0FBakI7QUFDRCxPQVhNLE1BV0EsSUFBSUYsVUFBVXZNLE1BQVYsSUFBb0IsQ0FBeEIsRUFBMkI7QUFDaENzTSxvQkFBWTNNLElBQVosQ0FBaUJyQixLQUFLNkIsTUFBTCxDQUFZLFFBQVosRUFBc0JvTSxVQUFVLENBQVYsQ0FBdEIsRUFBcUMsSUFBR0EsVUFBVUcsTUFBVixDQUFpQixDQUFqQixFQUFvQi9GLElBQXBCLENBQXlCLEtBQXpCLENBQWdDLEdBQXhFLENBQWpCO0FBQ0Q7QUFDRjtBQUNEeUYsbUJBQWVFLFlBQVkzRixJQUFaLENBQWlCLEdBQWpCLENBQWY7QUFDRDtBQUNELFNBQU95RixZQUFQO0FBQ0QsQ0E5QkQ7O0FBZ0NBUSxPQUFPQyxPQUFQLEdBQWlCL04sTUFBakIiLCJmaWxlIjoicGFyc2VyLmpzIiwic291cmNlc0NvbnRlbnQiOlsiY29uc3QgUHJvbWlzZSA9IHJlcXVpcmUoJ2JsdWViaXJkJyk7XG5jb25zdCBfID0gcmVxdWlyZSgnbG9kYXNoJyk7XG5jb25zdCB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuXG5sZXQgZHNlRHJpdmVyO1xudHJ5IHtcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGltcG9ydC9uby1leHRyYW5lb3VzLWRlcGVuZGVuY2llcywgaW1wb3J0L25vLXVucmVzb2x2ZWRcbiAgZHNlRHJpdmVyID0gcmVxdWlyZSgnZHNlLWRyaXZlcicpO1xufSBjYXRjaCAoZSkge1xuICBkc2VEcml2ZXIgPSBudWxsO1xufVxuXG5jb25zdCBjcWwgPSBQcm9taXNlLnByb21pc2lmeUFsbChkc2VEcml2ZXIgfHwgcmVxdWlyZSgnY2Fzc2FuZHJhLWRyaXZlcicpKTtcblxuY29uc3QgYnVpbGRFcnJvciA9IHJlcXVpcmUoJy4uL29ybS9hcG9sbG9fZXJyb3IuanMnKTtcbmNvbnN0IGRhdGF0eXBlcyA9IHJlcXVpcmUoJy4uL3ZhbGlkYXRvcnMvZGF0YXR5cGVzJyk7XG5jb25zdCBzY2hlbWVyID0gcmVxdWlyZSgnLi4vdmFsaWRhdG9ycy9zY2hlbWEnKTtcblxuY29uc3QgcGFyc2VyID0ge307XG5jb25zdCBzZXRDaGFyQXQgPSAoc3RyLGluZGV4LCBjaHIpID0+IHN0ci5zdWJzdHIoMCxpbmRleCkgKyBjaHIgKyBzdHIuc3Vic3RyKGluZGV4KzEpO1xuXG5wYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSA9IGZ1bmN0aW9uIGYoZm9ybWF0U3RyaW5nLCAuLi5wYXJhbXMpe1xuXG4gIGNvbnN0IHBsYWNlaG9sZGVycyA9IFtdO1xuXG4gIGNvbnN0IHJlID0gLyUuL2c7XG4gIGxldCBtYXRjaDtcbiAgZG8ge1xuICAgICAgbWF0Y2ggPSByZS5leGVjKGZvcm1hdFN0cmluZyk7XG4gICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgICBwbGFjZWhvbGRlcnMucHVzaChtYXRjaClcbiAgICAgIH1cbiAgfSB3aGlsZSAobWF0Y2gpO1xuXG4gIChwYXJhbXMgfHwgW10pLmZvckVhY2goKHAsaSkgPT4ge1xuICAgIGlmKGkgPCBwbGFjZWhvbGRlcnMubGVuZ3RoICYmIHR5cGVvZihwKSA9PT0gXCJzdHJpbmdcIiAmJiBwLmluZGV4T2YoXCItPlwiKSAhPT0gLTEpe1xuICAgICAgY29uc3QgZnAgPSBwbGFjZWhvbGRlcnNbaV07XG4gICAgICBpZihcbiAgICAgICAgZnAuaW5kZXggPiAwICYmXG4gICAgICAgIGZvcm1hdFN0cmluZy5sZW5ndGggPiBmcC5pbmRleCsyICYmXG4gICAgICAgIGZvcm1hdFN0cmluZ1tmcC5pbmRleC0xXSA9PT0gJ1wiJyAmJlxuICAgICAgICBmb3JtYXRTdHJpbmdbZnAuaW5kZXgrMl0gPT09ICdcIidcbiAgICAgICl7XG4gICAgICAgIGZvcm1hdFN0cmluZyA9IHNldENoYXJBdChmb3JtYXRTdHJpbmcsIGZwLmluZGV4LTEsIFwiIFwiKTtcbiAgICAgICAgZm9ybWF0U3RyaW5nID0gc2V0Q2hhckF0KGZvcm1hdFN0cmluZywgZnAuaW5kZXgrMiwgXCIgXCIpO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHV0aWwuZm9ybWF0KGZvcm1hdFN0cmluZywgLi4ucGFyYW1zKTtcbn1cbnBhcnNlci5kYl92YWx1ZV93aXRob3V0X2JpbmRfZm9yX0pTT05CX1lDUUxfQnVnID0gZnVuY3Rpb24gZihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSl7XG4gIFxuICBjb25zdCBpc0pzb25iQXR0ciA9IGZpZWxkTmFtZS5pbmRleE9mKFwiLT5cIikgIT09IC0xO1xuICBpZihpc0pzb25iQXR0cil7XG4gICAgY29uc3QgZmllbGROYW1lUm9vdCA9IGZpZWxkTmFtZS5zdWJzdHIoMCwgZmllbGROYW1lLmluZGV4T2YoXCItPlwiKSkucmVwbGFjZSgvXFxcIi9nLCBcIlwiKTtcbiAgICBjb25zdCBmaWVsZFJvb3RUeXBlID0gc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVSb290XS50eXBlIHx8wqBudWxsO1xuICAgIGlmIChmaWVsZFJvb3RUeXBlID09PSBcImpzb25iXCIpIHtcbiAgICAgIGlmKHR5cGVvZihmaWVsZFZhbHVlKSA9PT0gXCJzdHJpbmdcIil7XG4gICAgICAgIHJldHVybiB1dGlsLmZvcm1hdChcIiclcydcIiwgZmllbGRWYWx1ZSk7XG4gICAgICB9XG4gICAgICBlbHNle1xuICAgICAgICByZXR1cm4gdXRpbC5mb3JtYXQoXCInJXMnXCIsIEpTT04uc3RyaW5naWZ5KGZpZWxkVmFsdWUpKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgLy8gZWxzZXtcbiAgLy8gICBjb25zdCBmaWVsZE5hbWVSb290ID0gZmllbGROYW1lLnJlcGxhY2UoL1xcXCIvZywgXCJcIik7XG4gIC8vICAgY29uc3QgZmllbGRSb290VHlwZSA9IHNjaGVtYS5maWVsZHNbZmllbGROYW1lUm9vdF0udHlwZSB8fMKgbnVsbDtcbiAgLy8gICBpZihmaWVsZFJvb3RUeXBlID09PSBcImpzb25iXCIpe1xuICAvLyAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGZpZWxkVmFsdWUpO1xuICAvLyAgIH1cbiAgLy8gfVxuICBcbiAgcmV0dXJuIG51bGw7XG59XG5cbnBhcnNlci5jYWxsYmFja19vcl90aHJvdyA9IGZ1bmN0aW9uIGYoZXJyLCBjYWxsYmFjaykge1xuICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2FsbGJhY2soZXJyKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdGhyb3cgKGVycik7XG59O1xuXG5wYXJzZXIuZXh0cmFjdF90eXBlID0gZnVuY3Rpb24gZih2YWwpIHtcbiAgLy8gZGVjb21wb3NlIGNvbXBvc2l0ZSB0eXBlc1xuICBjb25zdCBkZWNvbXBvc2VkID0gdmFsID8gdmFsLnJlcGxhY2UoL1tcXHNdL2csICcnKS5zcGxpdCgvWzwsPl0vZykgOiBbJyddO1xuXG4gIGZvciAobGV0IGQgPSAwOyBkIDwgZGVjb21wb3NlZC5sZW5ndGg7IGQrKykge1xuICAgIGlmIChfLmhhcyhkYXRhdHlwZXMsIGRlY29tcG9zZWRbZF0pKSB7XG4gICAgICByZXR1cm4gZGVjb21wb3NlZFtkXTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdmFsO1xufTtcblxucGFyc2VyLmV4dHJhY3RfdHlwZURlZiA9IGZ1bmN0aW9uIGYodmFsKSB7XG4gIC8vIGRlY29tcG9zZSBjb21wb3NpdGUgdHlwZXNcbiAgbGV0IGRlY29tcG9zZWQgPSB2YWwgPyB2YWwucmVwbGFjZSgvW1xcc10vZywgJycpIDogJyc7XG4gIGRlY29tcG9zZWQgPSBkZWNvbXBvc2VkLnN1YnN0cihkZWNvbXBvc2VkLmluZGV4T2YoJzwnKSwgZGVjb21wb3NlZC5sZW5ndGggLSBkZWNvbXBvc2VkLmluZGV4T2YoJzwnKSk7XG5cbiAgcmV0dXJuIGRlY29tcG9zZWQ7XG59O1xuXG5wYXJzZXIuZXh0cmFjdF9hbHRlcmVkX3R5cGUgPSBmdW5jdGlvbiBmKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSwgZGlmZikge1xuICBjb25zdCBmaWVsZE5hbWUgPSBkaWZmLnBhdGhbMF07XG4gIGxldCB0eXBlID0gJyc7XG4gIGlmIChkaWZmLnBhdGgubGVuZ3RoID4gMSkge1xuICAgIGlmIChkaWZmLnBhdGhbMV0gPT09ICd0eXBlJykge1xuICAgICAgdHlwZSA9IGRpZmYucmhzO1xuICAgICAgaWYgKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlRGVmKSB7XG4gICAgICAgIHR5cGUgKz0gbm9ybWFsaXplZE1vZGVsU2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGVEZWY7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHR5cGUgPSBub3JtYWxpemVkTW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZTtcbiAgICAgIHR5cGUgKz0gZGlmZi5yaHM7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHR5cGUgPSBkaWZmLnJocy50eXBlO1xuICAgIGlmIChkaWZmLnJocy50eXBlRGVmKSB0eXBlICs9IGRpZmYucmhzLnR5cGVEZWY7XG4gIH1cbiAgcmV0dXJuIHR5cGU7XG59O1xuXG5wYXJzZXIuZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24gPSBmdW5jdGlvbiBmKHNjaGVtYSwgZmllbGROYW1lLCBmaWVsZFZhbHVlKSB7XG4gIGlmIChmaWVsZFZhbHVlID09IG51bGwgfHwgZmllbGRWYWx1ZSA9PT0gY3FsLnR5cGVzLnVuc2V0KSB7XG4gICAgcmV0dXJuIHsgcXVlcnlfc2VnbWVudDogJz8nLCBwYXJhbWV0ZXI6IGZpZWxkVmFsdWUgfTtcbiAgfVxuXG4gIGlmIChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kZGJfZnVuY3Rpb24pIHtcbiAgICByZXR1cm4gZmllbGRWYWx1ZS4kZGJfZnVuY3Rpb247XG4gIH1cblxuICBjb25zdCBmaWVsZFR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwgZmllbGROYW1lKTtcbiAgY29uc3QgdmFsaWRhdG9ycyA9IHNjaGVtZXIuZ2V0X3ZhbGlkYXRvcnMoc2NoZW1hLCBmaWVsZE5hbWUpO1xuXG4gIGlmIChfLmlzQXJyYXkoZmllbGRWYWx1ZSkgJiYgZmllbGRUeXBlICE9PSAnbGlzdCcgJiYgZmllbGRUeXBlICE9PSAnc2V0JyAmJiBmaWVsZFR5cGUgIT09ICdmcm96ZW4nKSB7XG4gICAgY29uc3QgdmFsID0gZmllbGRWYWx1ZS5tYXAoKHYpID0+IHtcbiAgICAgIGNvbnN0IGRiVmFsID0gcGFyc2VyLmdldF9kYl92YWx1ZV9leHByZXNzaW9uKHNjaGVtYSwgZmllbGROYW1lLCB2KTtcblxuICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkgcmV0dXJuIGRiVmFsLnBhcmFtZXRlcjtcbiAgICAgIHJldHVybiBkYlZhbDtcbiAgICB9KTtcblxuICAgIGNvbnN0IGpzb25iVW5iaW5kZWRCZWNhdXNlT2ZCdWcgPSBwYXJzZXIuZGJfdmFsdWVfd2l0aG91dF9iaW5kX2Zvcl9KU09OQl9ZQ1FMX0J1ZyhzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgaWYoanNvbmJVbmJpbmRlZEJlY2F1c2VPZkJ1Zyl7XG4gICAgICByZXR1cm4ganNvbmJVbmJpbmRlZEJlY2F1c2VPZkJ1ZztcbiAgICB9XG5cbiAgICByZXR1cm4geyBxdWVyeV9zZWdtZW50OiAnPycsIHBhcmFtZXRlcjogdmFsIH07XG4gIH1cblxuICBjb25zdCBqc29uYlVuYmluZGVkQmVjYXVzZU9mQnVnID0gcGFyc2VyLmRiX3ZhbHVlX3dpdGhvdXRfYmluZF9mb3JfSlNPTkJfWUNRTF9CdWcoc2NoZW1hLCBmaWVsZE5hbWUsIGZpZWxkVmFsdWUpO1xuXG4gIGNvbnN0IHZhbGlkYXRpb25NZXNzYWdlID0gc2NoZW1lci5nZXRfdmFsaWRhdGlvbl9tZXNzYWdlKHZhbGlkYXRvcnMsIGpzb25iVW5iaW5kZWRCZWNhdXNlT2ZCdWcgfHwgZmllbGRWYWx1ZSk7XG4gIGlmICh0eXBlb2YgdmFsaWRhdGlvbk1lc3NhZ2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWR2YWx1ZScsIHZhbGlkYXRpb25NZXNzYWdlKGpzb25iVW5iaW5kZWRCZWNhdXNlT2ZCdWcgfHwgZmllbGRWYWx1ZSwgZmllbGROYW1lLCBmaWVsZFR5cGUpKSk7XG4gIH1cblxuICBpZihqc29uYlVuYmluZGVkQmVjYXVzZU9mQnVnKXtcbiAgICByZXR1cm4ganNvbmJVbmJpbmRlZEJlY2F1c2VPZkJ1ZztcbiAgfVxuXG4gIGlmIChmaWVsZFR5cGUgPT09ICdjb3VudGVyJykge1xuICAgIGxldCBjb3VudGVyUXVlcnlTZWdtZW50ID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIGZpZWxkTmFtZSk7XG4gICAgaWYgKGZpZWxkVmFsdWUgPj0gMCkgY291bnRlclF1ZXJ5U2VnbWVudCArPSAnICsgPyc7XG4gICAgZWxzZSBjb3VudGVyUXVlcnlTZWdtZW50ICs9ICcgLSA/JztcbiAgICBmaWVsZFZhbHVlID0gTWF0aC5hYnMoZmllbGRWYWx1ZSk7XG4gICAgcmV0dXJuIHsgcXVlcnlfc2VnbWVudDogY291bnRlclF1ZXJ5U2VnbWVudCwgcGFyYW1ldGVyOiBmaWVsZFZhbHVlIH07XG4gIH1cblxuICByZXR1cm4geyBxdWVyeV9zZWdtZW50OiAnPycsIHBhcmFtZXRlcjogZmllbGRWYWx1ZSB9O1xufTtcblxucGFyc2VyLnVuc2V0X25vdF9hbGxvd2VkID0gZnVuY3Rpb24gZihvcGVyYXRpb24sIHNjaGVtYSwgZmllbGROYW1lLCBjYWxsYmFjaykge1xuICBpZiAoc2NoZW1lci5pc19wcmltYXJ5X2tleV9maWVsZChzY2hlbWEsIGZpZWxkTmFtZSkpIHtcbiAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coYnVpbGRFcnJvcihgbW9kZWwuJHtvcGVyYXRpb259LnVuc2V0a2V5YCwgZmllbGROYW1lKSwgY2FsbGJhY2spO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGlmIChzY2hlbWVyLmlzX3JlcXVpcmVkX2ZpZWxkKHNjaGVtYSwgZmllbGROYW1lKSkge1xuICAgIHBhcnNlci5jYWxsYmFja19vcl90aHJvdyhidWlsZEVycm9yKGBtb2RlbC4ke29wZXJhdGlvbn0udW5zZXRyZXF1aXJlZGAsIGZpZWxkTmFtZSksIGNhbGxiYWNrKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59O1xuXG5wYXJzZXIuZ2V0X2lucGxhY2VfdXBkYXRlX2V4cHJlc3Npb24gPSBmdW5jdGlvbiBmKHNjaGVtYSwgZmllbGROYW1lLCBmaWVsZFZhbHVlLCB1cGRhdGVDbGF1c2VzLCBxdWVyeVBhcmFtcykge1xuICBjb25zdCAkYWRkID0gKF8uaXNQbGFpbk9iamVjdChmaWVsZFZhbHVlKSAmJiBmaWVsZFZhbHVlLiRhZGQpIHx8IGZhbHNlO1xuICBjb25zdCAkYXBwZW5kID0gKF8uaXNQbGFpbk9iamVjdChmaWVsZFZhbHVlKSAmJiBmaWVsZFZhbHVlLiRhcHBlbmQpIHx8IGZhbHNlO1xuICBjb25zdCAkcHJlcGVuZCA9IChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kcHJlcGVuZCkgfHwgZmFsc2U7XG4gIGNvbnN0ICRyZXBsYWNlID0gKF8uaXNQbGFpbk9iamVjdChmaWVsZFZhbHVlKSAmJiBmaWVsZFZhbHVlLiRyZXBsYWNlKSB8fCBmYWxzZTtcbiAgY29uc3QgJHJlbW92ZSA9IChfLmlzUGxhaW5PYmplY3QoZmllbGRWYWx1ZSkgJiYgZmllbGRWYWx1ZS4kcmVtb3ZlKSB8fCBmYWxzZTtcblxuICBmaWVsZFZhbHVlID0gJGFkZCB8fCAkYXBwZW5kIHx8ICRwcmVwZW5kIHx8ICRyZXBsYWNlIHx8ICRyZW1vdmUgfHwgZmllbGRWYWx1ZTtcblxuICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG5cbiAgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGJWYWwpIHx8ICFkYlZhbC5xdWVyeV9zZWdtZW50KSB7XG4gICAgdXBkYXRlQ2xhdXNlcy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCI9JXMnLCBmaWVsZE5hbWUsIGRiVmFsKSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgZmllbGRUeXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG5cbiAgaWYgKFsnbWFwJywgJ2xpc3QnLCAnc2V0J10uaW5jbHVkZXMoZmllbGRUeXBlKSkge1xuICAgIGlmICgkYWRkIHx8ICRhcHBlbmQpIHtcbiAgICAgIGRiVmFsLnF1ZXJ5X3NlZ21lbnQgPSBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiICsgJXMnLCBmaWVsZE5hbWUsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpO1xuICAgIH0gZWxzZSBpZiAoJHByZXBlbmQpIHtcbiAgICAgIGlmIChmaWVsZFR5cGUgPT09ICdsaXN0Jykge1xuICAgICAgICBkYlZhbC5xdWVyeV9zZWdtZW50ID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJyVzICsgXCIlc1wiJywgZGJWYWwucXVlcnlfc2VnbWVudCwgZmllbGROYW1lKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKFxuICAgICAgICAgICdtb2RlbC51cGRhdGUuaW52YWxpZHByZXBlbmRvcCcsXG4gICAgICAgICAgdXRpbC5mb3JtYXQoJyVzIGRhdGF0eXBlcyBkb2VzIG5vdCBzdXBwb3J0ICRwcmVwZW5kLCB1c2UgJGFkZCBpbnN0ZWFkJywgZmllbGRUeXBlKSxcbiAgICAgICAgKSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICgkcmVtb3ZlKSB7XG4gICAgICBkYlZhbC5xdWVyeV9zZWdtZW50ID0gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIiAtICVzJywgZmllbGROYW1lLCBkYlZhbC5xdWVyeV9zZWdtZW50KTtcbiAgICAgIGlmIChmaWVsZFR5cGUgPT09ICdtYXAnKSBkYlZhbC5wYXJhbWV0ZXIgPSBPYmplY3Qua2V5cyhkYlZhbC5wYXJhbWV0ZXIpO1xuICAgIH1cbiAgfVxuXG4gIGlmICgkcmVwbGFjZSkge1xuICAgIGlmIChmaWVsZFR5cGUgPT09ICdtYXAnKSB7XG4gICAgICB1cGRhdGVDbGF1c2VzLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIls/XT0lcycsIGZpZWxkTmFtZSwgZGJWYWwucXVlcnlfc2VnbWVudCkpO1xuICAgICAgY29uc3QgcmVwbGFjZUtleXMgPSBPYmplY3Qua2V5cyhkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgY29uc3QgcmVwbGFjZVZhbHVlcyA9IF8udmFsdWVzKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICBpZiAocmVwbGFjZUtleXMubGVuZ3RoID09PSAxKSB7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2gocmVwbGFjZUtleXNbMF0pO1xuICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKHJlcGxhY2VWYWx1ZXNbMF0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgKFxuICAgICAgICAgIGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5pbnZhbGlkcmVwbGFjZW9wJywgJyRyZXBsYWNlIGluIG1hcCBkb2VzIG5vdCBzdXBwb3J0IG1vcmUgdGhhbiBvbmUgaXRlbScpXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChmaWVsZFR5cGUgPT09ICdsaXN0Jykge1xuICAgICAgdXBkYXRlQ2xhdXNlcy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCJbP109JXMnLCBmaWVsZE5hbWUsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpKTtcbiAgICAgIGlmIChkYlZhbC5wYXJhbWV0ZXIubGVuZ3RoID09PSAyKSB7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyWzBdKTtcbiAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXJbMV0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoXG4gICAgICAgICAgJ21vZGVsLnVwZGF0ZS5pbnZhbGlkcmVwbGFjZW9wJyxcbiAgICAgICAgICAnJHJlcGxhY2UgaW4gbGlzdCBzaG91bGQgaGF2ZSBleGFjdGx5IDIgaXRlbXMsIGZpcnN0IG9uZSBhcyB0aGUgaW5kZXggYW5kIHRoZSBzZWNvbmQgb25lIGFzIHRoZSB2YWx1ZScsXG4gICAgICAgICkpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcihcbiAgICAgICAgJ21vZGVsLnVwZGF0ZS5pbnZhbGlkcmVwbGFjZW9wJyxcbiAgICAgICAgdXRpbC5mb3JtYXQoJyVzIGRhdGF0eXBlcyBkb2VzIG5vdCBzdXBwb3J0ICRyZXBsYWNlJywgZmllbGRUeXBlKSxcbiAgICAgICkpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB1cGRhdGVDbGF1c2VzLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIj0lcycsIGZpZWxkTmFtZSwgZGJWYWwucXVlcnlfc2VnbWVudCkpO1xuICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyKTtcbiAgfVxufTtcblxucGFyc2VyLmdldF91cGRhdGVfdmFsdWVfZXhwcmVzc2lvbiA9IGZ1bmN0aW9uIGYoaW5zdGFuY2UsIHNjaGVtYSwgdXBkYXRlVmFsdWVzLCBjYWxsYmFjaykge1xuICBjb25zdCB1cGRhdGVDbGF1c2VzID0gW107XG4gIGNvbnN0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgaWYgKHNjaGVtYS5vcHRpb25zICYmIHNjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMpIHtcbiAgICBpZiAoIXVwZGF0ZVZhbHVlc1tzY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzLnVwZGF0ZWRBdF0pIHtcbiAgICAgIHVwZGF0ZVZhbHVlc1tzY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzLnVwZGF0ZWRBdF0gPSB7ICRkYl9mdW5jdGlvbjogJ3RvVGltZXN0YW1wKG5vdygpKScgfTtcbiAgICB9XG4gIH1cblxuICBpZiAoc2NoZW1hLm9wdGlvbnMgJiYgc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMpIHtcbiAgICBpZiAoIXVwZGF0ZVZhbHVlc1tzY2hlbWEub3B0aW9ucy52ZXJzaW9ucy5rZXldKSB7XG4gICAgICB1cGRhdGVWYWx1ZXNbc2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5XSA9IHsgJGRiX2Z1bmN0aW9uOiAnbm93KCknIH07XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZXJyb3JIYXBwZW5lZCA9IE9iamVjdC5rZXlzKHVwZGF0ZVZhbHVlcykuc29tZSgoZmllbGROYW1lKSA9PiB7XG4gICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSA9PT0gdW5kZWZpbmVkIHx8IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS52aXJ0dWFsKSByZXR1cm4gZmFsc2U7XG5cbiAgICBjb25zdCBmaWVsZFR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwgZmllbGROYW1lKTtcbiAgICBsZXQgZmllbGRWYWx1ZSA9IHVwZGF0ZVZhbHVlc1tmaWVsZE5hbWVdO1xuXG4gICAgaWYgKGZpZWxkVmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZmllbGRWYWx1ZSA9IGluc3RhbmNlLl9nZXRfZGVmYXVsdF92YWx1ZShmaWVsZE5hbWUpO1xuICAgICAgaWYgKGZpZWxkVmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXR1cm4gcGFyc2VyLnVuc2V0X25vdF9hbGxvd2VkKCd1cGRhdGUnLCBzY2hlbWEsIGZpZWxkTmFtZSwgY2FsbGJhY2spO1xuICAgICAgfSBlbHNlIGlmICghc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnJ1bGUgfHwgIXNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5ydWxlLmlnbm9yZV9kZWZhdWx0KSB7XG4gICAgICAgIC8vIGRpZCBzZXQgYSBkZWZhdWx0IHZhbHVlLCBpZ25vcmUgZGVmYXVsdCBpcyBub3Qgc2V0XG4gICAgICAgIGlmIChpbnN0YW5jZS52YWxpZGF0ZShmaWVsZE5hbWUsIGZpZWxkVmFsdWUpICE9PSB0cnVlKSB7XG4gICAgICAgICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5pbnZhbGlkZGVmYXVsdHZhbHVlJywgZmllbGRWYWx1ZSwgZmllbGROYW1lLCBmaWVsZFR5cGUpLCBjYWxsYmFjayk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZSA9PT0gbnVsbCB8fCBmaWVsZFZhbHVlID09PSBjcWwudHlwZXMudW5zZXQpIHtcbiAgICAgIGlmIChwYXJzZXIudW5zZXRfbm90X2FsbG93ZWQoJ3VwZGF0ZScsIHNjaGVtYSwgZmllbGROYW1lLCBjYWxsYmFjaykpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIHBhcnNlci5nZXRfaW5wbGFjZV91cGRhdGVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZSwgZmllbGRWYWx1ZSwgdXBkYXRlQ2xhdXNlcywgcXVlcnlQYXJhbXMpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHBhcnNlci5jYWxsYmFja19vcl90aHJvdyhlLCBjYWxsYmFjayk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9KTtcblxuICByZXR1cm4geyB1cGRhdGVDbGF1c2VzLCBxdWVyeVBhcmFtcywgZXJyb3JIYXBwZW5lZCB9O1xufTtcblxucGFyc2VyLmdldF9zYXZlX3ZhbHVlX2V4cHJlc3Npb24gPSBmdW5jdGlvbiBmbihpbnN0YW5jZSwgc2NoZW1hLCBjYWxsYmFjaykge1xuICBjb25zdCBpZGVudGlmaWVycyA9IFtdO1xuICBjb25zdCB2YWx1ZXMgPSBbXTtcbiAgY29uc3QgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBpZiAoc2NoZW1hLm9wdGlvbnMgJiYgc2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcykge1xuICAgIGlmIChpbnN0YW5jZVtzY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzLnVwZGF0ZWRBdF0pIHtcbiAgICAgIGluc3RhbmNlW3NjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMudXBkYXRlZEF0XSA9IHsgJGRiX2Z1bmN0aW9uOiAndG9UaW1lc3RhbXAobm93KCkpJyB9O1xuICAgIH1cbiAgfVxuXG4gIGlmIChzY2hlbWEub3B0aW9ucyAmJiBzY2hlbWEub3B0aW9ucy52ZXJzaW9ucykge1xuICAgIGlmIChpbnN0YW5jZVtzY2hlbWEub3B0aW9ucy52ZXJzaW9ucy5rZXldKSB7XG4gICAgICBpbnN0YW5jZVtzY2hlbWEub3B0aW9ucy52ZXJzaW9ucy5rZXldID0geyAkZGJfZnVuY3Rpb246ICdub3coKScgfTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBlcnJvckhhcHBlbmVkID0gT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuc29tZSgoZmllbGROYW1lKSA9PiB7XG4gICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS52aXJ0dWFsKSByZXR1cm4gZmFsc2U7XG5cbiAgICAvLyBjaGVjayBmaWVsZCB2YWx1ZVxuICAgIGNvbnN0IGZpZWxkVHlwZSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBmaWVsZE5hbWUpO1xuICAgIGxldCBmaWVsZFZhbHVlID0gaW5zdGFuY2VbZmllbGROYW1lXTtcblxuICAgIGlmIChmaWVsZFZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGZpZWxkVmFsdWUgPSBpbnN0YW5jZS5fZ2V0X2RlZmF1bHRfdmFsdWUoZmllbGROYW1lKTtcbiAgICAgIGlmIChmaWVsZFZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIHBhcnNlci51bnNldF9ub3RfYWxsb3dlZCgnc2F2ZScsIHNjaGVtYSwgZmllbGROYW1lLCBjYWxsYmFjayk7XG4gICAgICB9IGVsc2UgaWYgKCFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0ucnVsZSB8fCAhc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnJ1bGUuaWdub3JlX2RlZmF1bHQpIHtcbiAgICAgICAgLy8gZGlkIHNldCBhIGRlZmF1bHQgdmFsdWUsIGlnbm9yZSBkZWZhdWx0IGlzIG5vdCBzZXRcbiAgICAgICAgaWYgKGluc3RhbmNlLnZhbGlkYXRlKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSkgIT09IHRydWUpIHtcbiAgICAgICAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5pbnZhbGlkZGVmYXVsdHZhbHVlJywgZmllbGRWYWx1ZSwgZmllbGROYW1lLCBmaWVsZFR5cGUpLCBjYWxsYmFjayk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZSA9PT0gbnVsbCB8fCBmaWVsZFZhbHVlID09PSBjcWwudHlwZXMudW5zZXQpIHtcbiAgICAgIGlmIChwYXJzZXIudW5zZXRfbm90X2FsbG93ZWQoJ3NhdmUnLCBzY2hlbWEsIGZpZWxkTmFtZSwgY2FsbGJhY2spKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlkZW50aWZpZXJzLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIGZpZWxkTmFtZSkpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRiVmFsID0gcGFyc2VyLmdldF9kYl92YWx1ZV9leHByZXNzaW9uKHNjaGVtYSwgZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHtcbiAgICAgICAgdmFsdWVzLnB1c2goZGJWYWwucXVlcnlfc2VnbWVudCk7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhbHVlcy5wdXNoKGRiVmFsKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coZSwgY2FsbGJhY2spO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSk7XG5cbiAgcmV0dXJuIHtcbiAgICBpZGVudGlmaWVycyxcbiAgICB2YWx1ZXMsXG4gICAgcXVlcnlQYXJhbXMsXG4gICAgZXJyb3JIYXBwZW5lZCxcbiAgfTtcbn07XG5cbnBhcnNlci5leHRyYWN0X3F1ZXJ5X3JlbGF0aW9ucyA9IGZ1bmN0aW9uIGYoZmllbGROYW1lLCByZWxhdGlvbktleSwgcmVsYXRpb25WYWx1ZSwgc2NoZW1hLCB2YWxpZE9wZXJhdG9ycykge1xuICBjb25zdCBxdWVyeVJlbGF0aW9ucyA9IFtdO1xuICBjb25zdCBxdWVyeVBhcmFtcyA9IFtdO1xuXG4gIGlmICghXy5oYXModmFsaWRPcGVyYXRvcnMsIHJlbGF0aW9uS2V5LnRvTG93ZXJDYXNlKCkpKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZG9wJywgcmVsYXRpb25LZXkpKTtcbiAgfVxuXG4gIHJlbGF0aW9uS2V5ID0gcmVsYXRpb25LZXkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKHJlbGF0aW9uS2V5ID09PSAnJGluJyAmJiAhXy5pc0FycmF5KHJlbGF0aW9uVmFsdWUpKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZGlub3AnKSk7XG4gIH1cbiAgaWYgKHJlbGF0aW9uS2V5ID09PSAnJHRva2VuJyAmJiAhKHJlbGF0aW9uVmFsdWUgaW5zdGFuY2VvZiBPYmplY3QpKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZHRva2VuJykpO1xuICB9XG5cbiAgbGV0IG9wZXJhdG9yID0gdmFsaWRPcGVyYXRvcnNbcmVsYXRpb25LZXldO1xuICBsZXQgd2hlcmVUZW1wbGF0ZSA9ICdcIiVzXCIgJXMgJXMnO1xuXG4gIGNvbnN0IGJ1aWxkUXVlcnlSZWxhdGlvbnMgPSAoZmllbGROYW1lTG9jYWwsIHJlbGF0aW9uVmFsdWVMb2NhbCkgPT4ge1xuICAgIGNvbnN0IGRiVmFsID0gcGFyc2VyLmdldF9kYl92YWx1ZV9leHByZXNzaW9uKHNjaGVtYSwgZmllbGROYW1lTG9jYWwsIHJlbGF0aW9uVmFsdWVMb2NhbCk7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZShcbiAgICAgICAgd2hlcmVUZW1wbGF0ZSxcbiAgICAgICAgZmllbGROYW1lTG9jYWwsIG9wZXJhdG9yLCBkYlZhbC5xdWVyeV9zZWdtZW50LFxuICAgICAgKSk7XG4gICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoXG4gICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgIGZpZWxkTmFtZUxvY2FsLCBvcGVyYXRvciwgZGJWYWwsXG4gICAgICApKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYnVpbGRUb2tlblF1ZXJ5UmVsYXRpb25zID0gKHRva2VuUmVsYXRpb25LZXksIHRva2VuUmVsYXRpb25WYWx1ZSkgPT4ge1xuICAgIHRva2VuUmVsYXRpb25LZXkgPSB0b2tlblJlbGF0aW9uS2V5LnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKF8uaGFzKHZhbGlkT3BlcmF0b3JzLCB0b2tlblJlbGF0aW9uS2V5KSAmJiB0b2tlblJlbGF0aW9uS2V5ICE9PSAnJHRva2VuJyAmJiB0b2tlblJlbGF0aW9uS2V5ICE9PSAnJGluJykge1xuICAgICAgb3BlcmF0b3IgPSB2YWxpZE9wZXJhdG9yc1t0b2tlblJlbGF0aW9uS2V5XTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZHRva2Vub3AnLCB0b2tlblJlbGF0aW9uS2V5KSk7XG4gICAgfVxuXG4gICAgaWYgKF8uaXNBcnJheSh0b2tlblJlbGF0aW9uVmFsdWUpKSB7XG4gICAgICBjb25zdCB0b2tlbktleXMgPSBmaWVsZE5hbWUuc3BsaXQoJywnKTtcbiAgICAgIGZvciAobGV0IHRva2VuSW5kZXggPSAwOyB0b2tlbkluZGV4IDwgdG9rZW5SZWxhdGlvblZhbHVlLmxlbmd0aDsgdG9rZW5JbmRleCsrKSB7XG4gICAgICAgIHRva2VuS2V5c1t0b2tlbkluZGV4XSA9IHRva2VuS2V5c1t0b2tlbkluZGV4XS50cmltKCk7XG4gICAgICAgIGNvbnN0IGRiVmFsID0gcGFyc2VyLmdldF9kYl92YWx1ZV9leHByZXNzaW9uKHNjaGVtYSwgdG9rZW5LZXlzW3Rva2VuSW5kZXhdLCB0b2tlblJlbGF0aW9uVmFsdWVbdG9rZW5JbmRleF0pO1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGRiVmFsKSAmJiBkYlZhbC5xdWVyeV9zZWdtZW50KSB7XG4gICAgICAgICAgdG9rZW5SZWxhdGlvblZhbHVlW3Rva2VuSW5kZXhdID0gZGJWYWwucXVlcnlfc2VnbWVudDtcbiAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdG9rZW5SZWxhdGlvblZhbHVlW3Rva2VuSW5kZXhdID0gZGJWYWw7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgIHRva2VuS2V5cy5qb2luKCdcIixcIicpLCBvcGVyYXRvciwgdG9rZW5SZWxhdGlvblZhbHVlLnRvU3RyaW5nKCksXG4gICAgICApKTtcbiAgICB9IGVsc2Uge1xuICAgICAgYnVpbGRRdWVyeVJlbGF0aW9ucyhmaWVsZE5hbWUsIHRva2VuUmVsYXRpb25WYWx1ZSk7XG4gICAgfVxuICB9O1xuXG4gIGlmIChyZWxhdGlvbktleSA9PT0gJyR0b2tlbicpIHtcbiAgICB3aGVyZVRlbXBsYXRlID0gJ3Rva2VuKFwiJXNcIikgJXMgdG9rZW4oJXMpJztcblxuICAgIGNvbnN0IHRva2VuUmVsYXRpb25LZXlzID0gT2JqZWN0LmtleXMocmVsYXRpb25WYWx1ZSk7XG4gICAgZm9yIChsZXQgdG9rZW5SSyA9IDA7IHRva2VuUksgPCB0b2tlblJlbGF0aW9uS2V5cy5sZW5ndGg7IHRva2VuUksrKykge1xuICAgICAgY29uc3QgdG9rZW5SZWxhdGlvbktleSA9IHRva2VuUmVsYXRpb25LZXlzW3Rva2VuUktdO1xuICAgICAgY29uc3QgdG9rZW5SZWxhdGlvblZhbHVlID0gcmVsYXRpb25WYWx1ZVt0b2tlblJlbGF0aW9uS2V5XTtcbiAgICAgIGJ1aWxkVG9rZW5RdWVyeVJlbGF0aW9ucyh0b2tlblJlbGF0aW9uS2V5LCB0b2tlblJlbGF0aW9uVmFsdWUpO1xuICAgIH1cbiAgfSBlbHNlIGlmIChyZWxhdGlvbktleSA9PT0gJyRjb250YWlucycpIHtcbiAgICBjb25zdCBmaWVsZFR5cGUxID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG4gICAgaWYgKFsnbWFwJywgJ2xpc3QnLCAnc2V0JywgJ2Zyb3plbiddLmluY2x1ZGVzKGZpZWxkVHlwZTEpKSB7XG4gICAgICBpZiAoZmllbGRUeXBlMSA9PT0gJ21hcCcgJiYgXy5pc1BsYWluT2JqZWN0KHJlbGF0aW9uVmFsdWUpKSB7XG4gICAgICAgIE9iamVjdC5rZXlzKHJlbGF0aW9uVmFsdWUpLmZvckVhY2goKGtleSkgPT4ge1xuICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoXG4gICAgICAgICAgICAnXCIlc1wiWyVzXSAlcyAlcycsXG4gICAgICAgICAgICBmaWVsZE5hbWUsICc/JywgJz0nLCAnPycsXG4gICAgICAgICAgKSk7XG4gICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChrZXkpO1xuICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2gocmVsYXRpb25WYWx1ZVtrZXldKTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKFxuICAgICAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICAgICAgZmllbGROYW1lLCBvcGVyYXRvciwgJz8nLFxuICAgICAgICApKTtcbiAgICAgICAgcXVlcnlQYXJhbXMucHVzaChyZWxhdGlvblZhbHVlKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZGNvbnRhaW5zb3AnKSk7XG4gICAgfVxuICB9IGVsc2UgaWYgKHJlbGF0aW9uS2V5ID09PSAnJGNvbnRhaW5zX2tleScpIHtcbiAgICBjb25zdCBmaWVsZFR5cGUyID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG4gICAgaWYgKGZpZWxkVHlwZTIgIT09ICdtYXAnKSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkY29udGFpbnNrZXlvcCcpKTtcbiAgICB9XG4gICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgIHdoZXJlVGVtcGxhdGUsXG4gICAgICBmaWVsZE5hbWUsIG9wZXJhdG9yLCAnPycsXG4gICAgKSk7XG4gICAgcXVlcnlQYXJhbXMucHVzaChyZWxhdGlvblZhbHVlKTtcbiAgfSBlbHNlIHtcbiAgICBidWlsZFF1ZXJ5UmVsYXRpb25zKGZpZWxkTmFtZSwgcmVsYXRpb25WYWx1ZSk7XG4gIH1cbiAgcmV0dXJuIHsgcXVlcnlSZWxhdGlvbnMsIHF1ZXJ5UGFyYW1zIH07XG59O1xuXG5wYXJzZXIuX3BhcnNlX3F1ZXJ5X29iamVjdCA9IGZ1bmN0aW9uIGYoc2NoZW1hLCBxdWVyeU9iamVjdCkge1xuICBsZXQgcXVlcnlSZWxhdGlvbnMgPSBbXTtcbiAgbGV0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgT2JqZWN0LmtleXMocXVlcnlPYmplY3QpLmZvckVhY2goKGZpZWxkTmFtZSkgPT4ge1xuICAgIGlmIChmaWVsZE5hbWUuc3RhcnRzV2l0aCgnJCcpKSB7XG4gICAgICAvLyBzZWFyY2ggcXVlcmllcyBiYXNlZCBvbiBsdWNlbmUgaW5kZXggb3Igc29sclxuICAgICAgLy8gZXNjYXBlIGFsbCBzaW5nbGUgcXVvdGVzIGZvciBxdWVyaWVzIGluIGNhc3NhbmRyYVxuICAgICAgaWYgKGZpZWxkTmFtZSA9PT0gJyRleHByJykge1xuICAgICAgICBpZiAodHlwZW9mIHF1ZXJ5T2JqZWN0W2ZpZWxkTmFtZV0uaW5kZXggPT09ICdzdHJpbmcnICYmIHR5cGVvZiBxdWVyeU9iamVjdFtmaWVsZE5hbWVdLnF1ZXJ5ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgICAgICBcImV4cHIoJXMsJyVzJylcIixcbiAgICAgICAgICAgIHF1ZXJ5T2JqZWN0W2ZpZWxkTmFtZV0uaW5kZXgsIHF1ZXJ5T2JqZWN0W2ZpZWxkTmFtZV0ucXVlcnkucmVwbGFjZSgvJy9nLCBcIicnXCIpLFxuICAgICAgICAgICkpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRleHByJykpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkTmFtZSA9PT0gJyRzb2xyX3F1ZXJ5Jykge1xuICAgICAgICBpZiAodHlwZW9mIHF1ZXJ5T2JqZWN0W2ZpZWxkTmFtZV0gPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgIFwic29scl9xdWVyeT0nJXMnXCIsXG4gICAgICAgICAgICBxdWVyeU9iamVjdFtmaWVsZE5hbWVdLnJlcGxhY2UoLycvZywgXCInJ1wiKSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkc29scnF1ZXJ5JykpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbGV0IHdoZXJlT2JqZWN0ID0gcXVlcnlPYmplY3RbZmllbGROYW1lXTtcbiAgICAvLyBBcnJheSBvZiBvcGVyYXRvcnNcbiAgICBpZiAoIV8uaXNBcnJheSh3aGVyZU9iamVjdCkpIHdoZXJlT2JqZWN0ID0gW3doZXJlT2JqZWN0XTtcblxuICAgIGZvciAobGV0IGZrID0gMDsgZmsgPCB3aGVyZU9iamVjdC5sZW5ndGg7IGZrKyspIHtcbiAgICAgIGxldCBmaWVsZFJlbGF0aW9uID0gd2hlcmVPYmplY3RbZmtdO1xuXG4gICAgICBjb25zdCBjcWxPcGVyYXRvcnMgPSB7XG4gICAgICAgICRlcTogJz0nLFxuICAgICAgICAkbmU6ICchPScsXG4gICAgICAgICRpc250OiAnSVMgTk9UJyxcbiAgICAgICAgJGd0OiAnPicsXG4gICAgICAgICRsdDogJzwnLFxuICAgICAgICAkZ3RlOiAnPj0nLFxuICAgICAgICAkbHRlOiAnPD0nLFxuICAgICAgICAkaW46ICdJTicsXG4gICAgICAgICRsaWtlOiAnTElLRScsXG4gICAgICAgICR0b2tlbjogJ3Rva2VuJyxcbiAgICAgICAgJGNvbnRhaW5zOiAnQ09OVEFJTlMnLFxuICAgICAgICAkY29udGFpbnNfa2V5OiAnQ09OVEFJTlMgS0VZJyxcbiAgICAgIH07XG5cbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZmllbGRSZWxhdGlvbikpIHtcbiAgICAgICAgY29uc3QgdmFsaWRLZXlzID0gT2JqZWN0LmtleXMoY3FsT3BlcmF0b3JzKTtcbiAgICAgICAgY29uc3QgZmllbGRSZWxhdGlvbktleXMgPSBPYmplY3Qua2V5cyhmaWVsZFJlbGF0aW9uKTtcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBmaWVsZFJlbGF0aW9uS2V5cy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIGlmICghdmFsaWRLZXlzLmluY2x1ZGVzKGZpZWxkUmVsYXRpb25LZXlzW2ldKSkge1xuICAgICAgICAgICAgLy8gZmllbGQgcmVsYXRpb24ga2V5IGludmFsaWQsIGFwcGx5IGRlZmF1bHQgJGVxIG9wZXJhdG9yXG4gICAgICAgICAgICBmaWVsZFJlbGF0aW9uID0geyAkZXE6IGZpZWxkUmVsYXRpb24gfTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZmllbGRSZWxhdGlvbiA9IHsgJGVxOiBmaWVsZFJlbGF0aW9uIH07XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJlbGF0aW9uS2V5cyA9IE9iamVjdC5rZXlzKGZpZWxkUmVsYXRpb24pO1xuICAgICAgZm9yIChsZXQgcmsgPSAwOyByayA8IHJlbGF0aW9uS2V5cy5sZW5ndGg7IHJrKyspIHtcbiAgICAgICAgY29uc3QgcmVsYXRpb25LZXkgPSByZWxhdGlvbktleXNbcmtdO1xuICAgICAgICBjb25zdCByZWxhdGlvblZhbHVlID0gZmllbGRSZWxhdGlvbltyZWxhdGlvbktleV07XG4gICAgICAgIGNvbnN0IGV4dHJhY3RlZFJlbGF0aW9ucyA9IHBhcnNlci5leHRyYWN0X3F1ZXJ5X3JlbGF0aW9ucyhcbiAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgcmVsYXRpb25LZXksXG4gICAgICAgICAgcmVsYXRpb25WYWx1ZSxcbiAgICAgICAgICBzY2hlbWEsXG4gICAgICAgICAgY3FsT3BlcmF0b3JzLFxuICAgICAgICApO1xuICAgICAgICBxdWVyeVJlbGF0aW9ucyA9IHF1ZXJ5UmVsYXRpb25zLmNvbmNhdChleHRyYWN0ZWRSZWxhdGlvbnMucXVlcnlSZWxhdGlvbnMpO1xuICAgICAgICBxdWVyeVBhcmFtcyA9IHF1ZXJ5UGFyYW1zLmNvbmNhdChleHRyYWN0ZWRSZWxhdGlvbnMucXVlcnlQYXJhbXMpO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHsgcXVlcnlSZWxhdGlvbnMsIHF1ZXJ5UGFyYW1zIH07XG59O1xuXG5wYXJzZXIuZ2V0X2ZpbHRlcl9jbGF1c2UgPSBmdW5jdGlvbiBmKHNjaGVtYSwgcXVlcnlPYmplY3QsIGNsYXVzZSkge1xuICBjb25zdCBwYXJzZWRPYmplY3QgPSBwYXJzZXIuX3BhcnNlX3F1ZXJ5X29iamVjdChzY2hlbWEsIHF1ZXJ5T2JqZWN0KTtcbiAgY29uc3QgZmlsdGVyQ2xhdXNlID0ge307XG4gIGlmIChwYXJzZWRPYmplY3QucXVlcnlSZWxhdGlvbnMubGVuZ3RoID4gMCkge1xuICAgIGZpbHRlckNsYXVzZS5xdWVyeSA9IHV0aWwuZm9ybWF0KCclcyAlcycsIGNsYXVzZSwgcGFyc2VkT2JqZWN0LnF1ZXJ5UmVsYXRpb25zLmpvaW4oJyBBTkQgJykpO1xuICB9IGVsc2Uge1xuICAgIGZpbHRlckNsYXVzZS5xdWVyeSA9ICcnO1xuICB9XG4gIGZpbHRlckNsYXVzZS5wYXJhbXMgPSBwYXJzZWRPYmplY3QucXVlcnlQYXJhbXM7XG4gIHJldHVybiBmaWx0ZXJDbGF1c2U7XG59O1xuXG5wYXJzZXIuZ2V0X2ZpbHRlcl9jbGF1c2VfZGRsID0gZnVuY3Rpb24gZihzY2hlbWEsIHF1ZXJ5T2JqZWN0LCBjbGF1c2UpIHtcbiAgY29uc3QgZmlsdGVyQ2xhdXNlID0gcGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlKHNjaGVtYSwgcXVlcnlPYmplY3QsIGNsYXVzZSk7XG4gIGxldCBmaWx0ZXJRdWVyeSA9IGZpbHRlckNsYXVzZS5xdWVyeTtcbiAgZmlsdGVyQ2xhdXNlLnBhcmFtcy5mb3JFYWNoKChwYXJhbSkgPT4ge1xuICAgIGxldCBxdWVyeVBhcmFtO1xuICAgIGlmICh0eXBlb2YgcGFyYW0gPT09ICdzdHJpbmcnKSB7XG4gICAgICBxdWVyeVBhcmFtID0gdXRpbC5mb3JtYXQoXCInJXMnXCIsIHBhcmFtKTtcbiAgICB9IGVsc2UgaWYgKHBhcmFtIGluc3RhbmNlb2YgRGF0ZSkge1xuICAgICAgcXVlcnlQYXJhbSA9IHV0aWwuZm9ybWF0KFwiJyVzJ1wiLCBwYXJhbS50b0lTT1N0cmluZygpKTtcbiAgICB9IGVsc2UgaWYgKHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLkxvbmdcbiAgICAgIHx8IHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLkludGVnZXJcbiAgICAgIHx8IHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLkJpZ0RlY2ltYWxcbiAgICAgIHx8IHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLlRpbWVVdWlkXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5VdWlkKSB7XG4gICAgICBxdWVyeVBhcmFtID0gcGFyYW0udG9TdHJpbmcoKTtcbiAgICB9IGVsc2UgaWYgKHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLkxvY2FsRGF0ZVxuICAgICAgfHwgcGFyYW0gaW5zdGFuY2VvZiBjcWwudHlwZXMuTG9jYWxUaW1lXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5JbmV0QWRkcmVzcykge1xuICAgICAgcXVlcnlQYXJhbSA9IHV0aWwuZm9ybWF0KFwiJyVzJ1wiLCBwYXJhbS50b1N0cmluZygpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcXVlcnlQYXJhbSA9IHBhcmFtO1xuICAgIH1cbiAgICAvLyBUT0RPOiB1bmhhbmRsZWQgaWYgcXVlcnlQYXJhbSBpcyBhIHN0cmluZyBjb250YWluaW5nID8gY2hhcmFjdGVyXG4gICAgLy8gdGhvdWdoIHRoaXMgaXMgdW5saWtlbHkgdG8gaGF2ZSBpbiBtYXRlcmlhbGl6ZWQgdmlldyBmaWx0ZXJzLCBidXQuLi5cbiAgICBmaWx0ZXJRdWVyeSA9IGZpbHRlclF1ZXJ5LnJlcGxhY2UoJz8nLCBxdWVyeVBhcmFtKTtcbiAgfSk7XG4gIHJldHVybiBmaWx0ZXJRdWVyeTtcbn07XG5cbnBhcnNlci5nZXRfd2hlcmVfY2xhdXNlID0gZnVuY3Rpb24gZihzY2hlbWEsIHF1ZXJ5T2JqZWN0KSB7XG4gIHJldHVybiBwYXJzZXIuZ2V0X2ZpbHRlcl9jbGF1c2Uoc2NoZW1hLCBxdWVyeU9iamVjdCwgJ1dIRVJFJyk7XG59O1xuXG5wYXJzZXIuZ2V0X2lmX2NsYXVzZSA9IGZ1bmN0aW9uIGYoc2NoZW1hLCBxdWVyeU9iamVjdCkge1xuICByZXR1cm4gcGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlKHNjaGVtYSwgcXVlcnlPYmplY3QsICdJRicpO1xufTtcblxucGFyc2VyLmdldF9wcmltYXJ5X2tleV9jbGF1c2VzID0gZnVuY3Rpb24gZihzY2hlbWEpIHtcbiAgY29uc3QgcGFydGl0aW9uS2V5ID0gc2NoZW1hLmtleVswXTtcbiAgbGV0IGNsdXN0ZXJpbmdLZXkgPSBzY2hlbWEua2V5LnNsaWNlKDEsIHNjaGVtYS5rZXkubGVuZ3RoKTtcbiAgY29uc3QgY2x1c3RlcmluZ09yZGVyID0gW107XG5cbiAgZm9yIChsZXQgZmllbGQgPSAwOyBmaWVsZCA8IGNsdXN0ZXJpbmdLZXkubGVuZ3RoOyBmaWVsZCsrKSB7XG4gICAgaWYgKHNjaGVtYS5jbHVzdGVyaW5nX29yZGVyXG4gICAgICAgICYmIHNjaGVtYS5jbHVzdGVyaW5nX29yZGVyW2NsdXN0ZXJpbmdLZXlbZmllbGRdXVxuICAgICAgICAmJiBzY2hlbWEuY2x1c3RlcmluZ19vcmRlcltjbHVzdGVyaW5nS2V5W2ZpZWxkXV0udG9Mb3dlckNhc2UoKSA9PT0gJ2Rlc2MnKSB7XG4gICAgICBjbHVzdGVyaW5nT3JkZXIucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiIERFU0MnLCBjbHVzdGVyaW5nS2V5W2ZpZWxkXSkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjbHVzdGVyaW5nT3JkZXIucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiIEFTQycsIGNsdXN0ZXJpbmdLZXlbZmllbGRdKSk7XG4gICAgfVxuICB9XG5cbiAgbGV0IGNsdXN0ZXJpbmdPcmRlckNsYXVzZSA9ICcnO1xuICBpZiAoY2x1c3RlcmluZ09yZGVyLmxlbmd0aCA+IDApIHtcbiAgICBjbHVzdGVyaW5nT3JkZXJDbGF1c2UgPSB1dGlsLmZvcm1hdCgnIFdJVEggQ0xVU1RFUklORyBPUkRFUiBCWSAoJXMpJywgY2x1c3RlcmluZ09yZGVyLnRvU3RyaW5nKCkpO1xuICB9XG5cbiAgbGV0IHBhcnRpdGlvbktleUNsYXVzZSA9ICcnO1xuICBpZiAoXy5pc0FycmF5KHBhcnRpdGlvbktleSkpIHtcbiAgICBwYXJ0aXRpb25LZXlDbGF1c2UgPSBwYXJ0aXRpb25LZXkubWFwKCh2KSA9PiBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiJywgdikpLmpvaW4oJywnKTtcbiAgfSBlbHNlIHtcbiAgICBwYXJ0aXRpb25LZXlDbGF1c2UgPSBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiJywgcGFydGl0aW9uS2V5KTtcbiAgfVxuXG4gIGxldCBjbHVzdGVyaW5nS2V5Q2xhdXNlID0gJyc7XG4gIGlmIChjbHVzdGVyaW5nS2V5Lmxlbmd0aCkge1xuICAgIGNsdXN0ZXJpbmdLZXkgPSBjbHVzdGVyaW5nS2V5Lm1hcCgodikgPT4gcGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIicsIHYpKS5qb2luKCcsJyk7XG4gICAgY2x1c3RlcmluZ0tleUNsYXVzZSA9IHV0aWwuZm9ybWF0KCcsJXMnLCBjbHVzdGVyaW5nS2V5KTtcbiAgfVxuXG4gIHJldHVybiB7IHBhcnRpdGlvbktleUNsYXVzZSwgY2x1c3RlcmluZ0tleUNsYXVzZSwgY2x1c3RlcmluZ09yZGVyQ2xhdXNlIH07XG59O1xuXG5wYXJzZXIuZ2V0X212aWV3X3doZXJlX2NsYXVzZSA9IGZ1bmN0aW9uIGYoc2NoZW1hLCB2aWV3U2NoZW1hKSB7XG4gIGNvbnN0IGNsYXVzZXMgPSBwYXJzZXIuZ2V0X3ByaW1hcnlfa2V5X2NsYXVzZXModmlld1NjaGVtYSk7XG4gIGxldCB3aGVyZUNsYXVzZSA9IGNsYXVzZXMucGFydGl0aW9uS2V5Q2xhdXNlLnNwbGl0KCcsJykuam9pbignIElTIE5PVCBOVUxMIEFORCAnKTtcbiAgaWYgKGNsYXVzZXMuY2x1c3RlcmluZ0tleUNsYXVzZSkgd2hlcmVDbGF1c2UgKz0gY2xhdXNlcy5jbHVzdGVyaW5nS2V5Q2xhdXNlLnNwbGl0KCcsJykuam9pbignIElTIE5PVCBOVUxMIEFORCAnKTtcbiAgd2hlcmVDbGF1c2UgKz0gJyBJUyBOT1QgTlVMTCc7XG5cbiAgY29uc3QgZmlsdGVycyA9IF8uY2xvbmVEZWVwKHZpZXdTY2hlbWEuZmlsdGVycyk7XG5cbiAgaWYgKF8uaXNQbGFpbk9iamVjdChmaWx0ZXJzKSkge1xuICAgIC8vIGRlbGV0ZSBwcmltYXJ5IGtleSBmaWVsZHMgZGVmaW5lZCBhcyBpc24ndCBudWxsIGluIGZpbHRlcnNcbiAgICBPYmplY3Qua2V5cyhmaWx0ZXJzKS5mb3JFYWNoKChmaWx0ZXJLZXkpID0+IHtcbiAgICAgIGlmIChmaWx0ZXJzW2ZpbHRlcktleV0uJGlzbnQgPT09IG51bGxcbiAgICAgICAgICAmJiAodmlld1NjaGVtYS5rZXkuaW5jbHVkZXMoZmlsdGVyS2V5KSB8fCB2aWV3U2NoZW1hLmtleVswXS5pbmNsdWRlcyhmaWx0ZXJLZXkpKSkge1xuICAgICAgICBkZWxldGUgZmlsdGVyc1tmaWx0ZXJLZXldLiRpc250O1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgY29uc3QgZmlsdGVyQ2xhdXNlID0gcGFyc2VyLmdldF9maWx0ZXJfY2xhdXNlX2RkbChzY2hlbWEsIGZpbHRlcnMsICdBTkQnKTtcbiAgICB3aGVyZUNsYXVzZSArPSB1dGlsLmZvcm1hdCgnICVzJywgZmlsdGVyQ2xhdXNlKS5yZXBsYWNlKC9JUyBOT1QgbnVsbC9nLCAnSVMgTk9UIE5VTEwnKTtcbiAgfVxuXG4gIC8vIHJlbW92ZSB1bm5lY2Vzc2FyaWx5IHF1b3RlZCBmaWVsZCBuYW1lcyBpbiBnZW5lcmF0ZWQgd2hlcmUgY2xhdXNlXG4gIC8vIHNvIHRoYXQgaXQgbWF0Y2hlcyB0aGUgd2hlcmVfY2xhdXNlIGZyb20gZGF0YWJhc2Ugc2NoZW1hXG4gIGNvbnN0IHF1b3RlZEZpZWxkTmFtZXMgPSB3aGVyZUNsYXVzZS5tYXRjaCgvXCIoLio/KVwiL2cpO1xuICBxdW90ZWRGaWVsZE5hbWVzLmZvckVhY2goKGZpZWxkTmFtZSkgPT4ge1xuICAgIGNvbnN0IHVucXVvdGVkRmllbGROYW1lID0gZmllbGROYW1lLnJlcGxhY2UoL1wiL2csICcnKTtcbiAgICBjb25zdCByZXNlcnZlZEtleXdvcmRzID0gW1xuICAgICAgJ0FERCcsICdBR0dSRUdBVEUnLCAnQUxMT1cnLCAnQUxURVInLCAnQU5EJywgJ0FOWScsICdBUFBMWScsXG4gICAgICAnQVNDJywgJ0FVVEhPUklaRScsICdCQVRDSCcsICdCRUdJTicsICdCWScsICdDT0xVTU5GQU1JTFknLFxuICAgICAgJ0NSRUFURScsICdERUxFVEUnLCAnREVTQycsICdEUk9QJywgJ0VBQ0hfUVVPUlVNJywgJ0VOVFJJRVMnLFxuICAgICAgJ0ZST00nLCAnRlVMTCcsICdHUkFOVCcsICdJRicsICdJTicsICdJTkRFWCcsICdJTkVUJywgJ0lORklOSVRZJyxcbiAgICAgICdJTlNFUlQnLCAnSU5UTycsICdLRVlTUEFDRScsICdLRVlTUEFDRVMnLCAnTElNSVQnLCAnTE9DQUxfT05FJyxcbiAgICAgICdMT0NBTF9RVU9SVU0nLCAnTUFURVJJQUxJWkVEJywgJ01PRElGWScsICdOQU4nLCAnTk9SRUNVUlNJVkUnLFxuICAgICAgJ05PVCcsICdPRicsICdPTicsICdPTkUnLCAnT1JERVInLCAnUEFSVElUSU9OJywgJ1BBU1NXT1JEJywgJ1BFUicsXG4gICAgICAnUFJJTUFSWScsICdRVU9SVU0nLCAnUkVOQU1FJywgJ1JFVk9LRScsICdTQ0hFTUEnLCAnU0VMRUNUJywgJ1NFVCcsXG4gICAgICAnVEFCTEUnLCAnVElNRScsICdUSFJFRScsICdUTycsICdUT0tFTicsICdUUlVOQ0FURScsICdUV08nLCAnVU5MT0dHRUQnLFxuICAgICAgJ1VQREFURScsICdVU0UnLCAnVVNJTkcnLCAnVklFVycsICdXSEVSRScsICdXSVRIJ107XG4gICAgaWYgKHVucXVvdGVkRmllbGROYW1lID09PSB1bnF1b3RlZEZpZWxkTmFtZS50b0xvd2VyQ2FzZSgpXG4gICAgICAmJiAhcmVzZXJ2ZWRLZXl3b3Jkcy5pbmNsdWRlcyh1bnF1b3RlZEZpZWxkTmFtZS50b1VwcGVyQ2FzZSgpKSkge1xuICAgICAgd2hlcmVDbGF1c2UgPSB3aGVyZUNsYXVzZS5yZXBsYWNlKGZpZWxkTmFtZSwgdW5xdW90ZWRGaWVsZE5hbWUpO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiB3aGVyZUNsYXVzZTtcbn07XG5cbnBhcnNlci5nZXRfb3JkZXJieV9jbGF1c2UgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0KSB7XG4gIGNvbnN0IG9yZGVyS2V5cyA9IFtdO1xuICBPYmplY3Qua2V5cyhxdWVyeU9iamVjdCkuZm9yRWFjaCgoaykgPT4ge1xuICAgIGNvbnN0IHF1ZXJ5SXRlbSA9IHF1ZXJ5T2JqZWN0W2tdO1xuICAgIGlmIChrLnRvTG93ZXJDYXNlKCkgPT09ICckb3JkZXJieScpIHtcbiAgICAgIGlmICghKHF1ZXJ5SXRlbSBpbnN0YW5jZW9mIE9iamVjdCkpIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZG9yZGVyJykpO1xuICAgICAgfVxuICAgICAgY29uc3Qgb3JkZXJJdGVtS2V5cyA9IE9iamVjdC5rZXlzKHF1ZXJ5SXRlbSk7XG5cbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgb3JkZXJJdGVtS2V5cy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCBjcWxPcmRlckRpcmVjdGlvbiA9IHsgJGFzYzogJ0FTQycsICRkZXNjOiAnREVTQycgfTtcbiAgICAgICAgaWYgKG9yZGVySXRlbUtleXNbaV0udG9Mb3dlckNhc2UoKSBpbiBjcWxPcmRlckRpcmVjdGlvbikge1xuICAgICAgICAgIGxldCBvcmRlckZpZWxkcyA9IHF1ZXJ5SXRlbVtvcmRlckl0ZW1LZXlzW2ldXTtcblxuICAgICAgICAgIGlmICghXy5pc0FycmF5KG9yZGVyRmllbGRzKSkge1xuICAgICAgICAgICAgb3JkZXJGaWVsZHMgPSBbb3JkZXJGaWVsZHNdO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGZvciAobGV0IGogPSAwOyBqIDwgb3JkZXJGaWVsZHMubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgICAgIG9yZGVyS2V5cy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKFxuICAgICAgICAgICAgICAnXCIlc1wiICVzJyxcbiAgICAgICAgICAgICAgb3JkZXJGaWVsZHNbal0sIGNxbE9yZGVyRGlyZWN0aW9uW29yZGVySXRlbUtleXNbaV1dLFxuICAgICAgICAgICAgKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRvcmRlcnR5cGUnLCBvcmRlckl0ZW1LZXlzW2ldKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuICByZXR1cm4gb3JkZXJLZXlzLmxlbmd0aCA/IHV0aWwuZm9ybWF0KCdPUkRFUiBCWSAlcycsIG9yZGVyS2V5cy5qb2luKCcsICcpKSA6ICcgJztcbn07XG5cbnBhcnNlci5nZXRfZ3JvdXBieV9jbGF1c2UgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0KSB7XG4gIGxldCBncm91cGJ5S2V5cyA9IFtdO1xuXG4gIE9iamVjdC5rZXlzKHF1ZXJ5T2JqZWN0KS5mb3JFYWNoKChrKSA9PiB7XG4gICAgY29uc3QgcXVlcnlJdGVtID0gcXVlcnlPYmplY3Rba107XG5cbiAgICBpZiAoay50b0xvd2VyQ2FzZSgpID09PSAnJGdyb3VwYnknKSB7XG4gICAgICBpZiAoIShxdWVyeUl0ZW0gaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZGdyb3VwJykpO1xuICAgICAgfVxuXG4gICAgICBncm91cGJ5S2V5cyA9IGdyb3VwYnlLZXlzLmNvbmNhdChxdWVyeUl0ZW0pO1xuICAgIH1cbiAgfSk7XG5cbiAgZ3JvdXBieUtleXMgPSBncm91cGJ5S2V5cy5tYXAoKGtleSkgPT4gYFwiJHtrZXl9XCJgKTtcblxuICByZXR1cm4gZ3JvdXBieUtleXMubGVuZ3RoID8gdXRpbC5mb3JtYXQoJ0dST1VQIEJZICVzJywgZ3JvdXBieUtleXMuam9pbignLCAnKSkgOiAnICc7XG59O1xuXG5wYXJzZXIuZ2V0X2xpbWl0X2NsYXVzZSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QpIHtcbiAgbGV0IGxpbWl0ID0gbnVsbDtcbiAgT2JqZWN0LmtleXMocXVlcnlPYmplY3QpLmZvckVhY2goKGspID0+IHtcbiAgICBjb25zdCBxdWVyeUl0ZW0gPSBxdWVyeU9iamVjdFtrXTtcbiAgICBpZiAoay50b0xvd2VyQ2FzZSgpID09PSAnJGxpbWl0Jykge1xuICAgICAgaWYgKHR5cGVvZiBxdWVyeUl0ZW0gIT09ICdudW1iZXInKSB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5saW1pdHR5cGUnKSk7XG4gICAgICBsaW1pdCA9IHF1ZXJ5SXRlbTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gbGltaXQgPyB1dGlsLmZvcm1hdCgnTElNSVQgJXMnLCBsaW1pdCkgOiAnICc7XG59O1xuXG5wYXJzZXIuZ2V0X3NlbGVjdF9jbGF1c2UgPSBmdW5jdGlvbiBmKG9wdGlvbnMpIHtcbiAgbGV0IHNlbGVjdENsYXVzZSA9ICcqJztcbiAgaWYgKG9wdGlvbnMuc2VsZWN0ICYmIF8uaXNBcnJheShvcHRpb25zLnNlbGVjdCkgJiYgb3B0aW9ucy5zZWxlY3QubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHNlbGVjdEFycmF5ID0gW107XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvcHRpb25zLnNlbGVjdC5sZW5ndGg7IGkrKykge1xuICAgICAgLy8gc2VwYXJhdGUgdGhlIGFnZ3JlZ2F0ZSBmdW5jdGlvbiBhbmQgdGhlIGNvbHVtbiBuYW1lIGlmIHNlbGVjdCBpcyBhbiBhZ2dyZWdhdGUgZnVuY3Rpb25cbiAgICAgIGNvbnN0IHNlbGVjdGlvbiA9IG9wdGlvbnMuc2VsZWN0W2ldLnNwbGl0KC9bKCwgKV0vZykuZmlsdGVyKChlKSA9PiAoZSkpO1xuICAgICAgaWYgKHNlbGVjdGlvbi5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgaWYgKHNlbGVjdGlvblswXSA9PT0gJyonKSBzZWxlY3RBcnJheS5wdXNoKCcqJyk7XG4gICAgICAgIGVsc2Ugc2VsZWN0QXJyYXkucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiJywgc2VsZWN0aW9uWzBdKSk7XG4gICAgICB9IGVsc2UgaWYgKHNlbGVjdGlvbi5sZW5ndGggPT09IDIpIHtcbiAgICAgICAgc2VsZWN0QXJyYXkucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnJXMoXCIlc1wiKScsIHNlbGVjdGlvblswXSwgc2VsZWN0aW9uWzFdKSk7XG4gICAgICB9IGVsc2UgaWYgKHNlbGVjdGlvbi5sZW5ndGggPj0gMyAmJiBzZWxlY3Rpb25bc2VsZWN0aW9uLmxlbmd0aCAtIDJdLnRvTG93ZXJDYXNlKCkgPT09ICdhcycpIHtcbiAgICAgICAgY29uc3Qgc2VsZWN0aW9uRW5kQ2h1bmsgPSBzZWxlY3Rpb24uc3BsaWNlKHNlbGVjdGlvbi5sZW5ndGggLSAyKTtcbiAgICAgICAgbGV0IHNlbGVjdGlvbkNodW5rID0gJyc7XG4gICAgICAgIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAxKSB7XG4gICAgICAgICAgc2VsZWN0aW9uQ2h1bmsgPSBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiJywgc2VsZWN0aW9uWzBdKTtcbiAgICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAyKSB7XG4gICAgICAgICAgc2VsZWN0aW9uQ2h1bmsgPSBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnJXMoXCIlc1wiKScsIHNlbGVjdGlvblswXSwgc2VsZWN0aW9uWzFdKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBzZWxlY3Rpb25DaHVuayA9IHV0aWwuZm9ybWF0KCclcyglcyknLCBzZWxlY3Rpb25bMF0sIGBcIiR7c2VsZWN0aW9uLnNwbGljZSgxKS5qb2luKCdcIixcIicpfVwiYCk7XG4gICAgICAgIH1cbiAgICAgICAgc2VsZWN0QXJyYXkucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnJXMgQVMgXCIlc1wiJywgc2VsZWN0aW9uQ2h1bmssIHNlbGVjdGlvbkVuZENodW5rWzFdKSk7XG4gICAgICB9IGVsc2UgaWYgKHNlbGVjdGlvbi5sZW5ndGggPj0gMykge1xuICAgICAgICBzZWxlY3RBcnJheS5wdXNoKHV0aWwuZm9ybWF0KCclcyglcyknLCBzZWxlY3Rpb25bMF0sIGBcIiR7c2VsZWN0aW9uLnNwbGljZSgxKS5qb2luKCdcIixcIicpfVwiYCkpO1xuICAgICAgfVxuICAgIH1cbiAgICBzZWxlY3RDbGF1c2UgPSBzZWxlY3RBcnJheS5qb2luKCcsJyk7XG4gIH1cbiAgcmV0dXJuIHNlbGVjdENsYXVzZTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gcGFyc2VyO1xuIl19