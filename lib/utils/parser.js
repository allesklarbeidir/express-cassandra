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
    return { query_segment: ':boundparam', parameter: fieldValue };
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

    return { query_segment: ':boundparam', parameter: val };
  }

  var validationMessage = schemer.get_validation_message(validators, fieldValue);
  if (typeof validationMessage === 'function') {
    throw buildError('model.validator.invalidvalue', validationMessage(fieldValue, fieldName, fieldType));
  }

  if (fieldType === 'counter') {
    var counterQuerySegment = parser.formatJSONBColumnAware('"%s"', fieldName);
    if (fieldValue >= 0) counterQuerySegment += ' + :boundparam';else counterQuerySegment += ' - :boundparam';
    fieldValue = Math.abs(fieldValue);
    return { query_segment: counterQuerySegment, parameter: fieldValue };
  }

  return { query_segment: ':boundparam', parameter: fieldValue };
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9wYXJzZXIuanMiXSwibmFtZXMiOlsiUHJvbWlzZSIsInJlcXVpcmUiLCJfIiwidXRpbCIsImRzZURyaXZlciIsImUiLCJjcWwiLCJwcm9taXNpZnlBbGwiLCJidWlsZEVycm9yIiwiZGF0YXR5cGVzIiwic2NoZW1lciIsInBhcnNlciIsInNldENoYXJBdCIsInN0ciIsImluZGV4IiwiY2hyIiwic3Vic3RyIiwiZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSIsImYiLCJmb3JtYXRTdHJpbmciLCJwbGFjZWhvbGRlcnMiLCJyZSIsIm1hdGNoIiwiZXhlYyIsInB1c2giLCJwYXJhbXMiLCJmb3JFYWNoIiwicCIsImkiLCJsZW5ndGgiLCJpbmRleE9mIiwiZnAiLCJmb3JtYXQiLCJjYWxsYmFja19vcl90aHJvdyIsImVyciIsImNhbGxiYWNrIiwiZXh0cmFjdF90eXBlIiwidmFsIiwiZGVjb21wb3NlZCIsInJlcGxhY2UiLCJzcGxpdCIsImQiLCJoYXMiLCJleHRyYWN0X3R5cGVEZWYiLCJleHRyYWN0X2FsdGVyZWRfdHlwZSIsIm5vcm1hbGl6ZWRNb2RlbFNjaGVtYSIsImRpZmYiLCJmaWVsZE5hbWUiLCJwYXRoIiwidHlwZSIsInJocyIsImZpZWxkcyIsInR5cGVEZWYiLCJnZXRfZGJfdmFsdWVfZXhwcmVzc2lvbiIsInNjaGVtYSIsImZpZWxkVmFsdWUiLCJ0eXBlcyIsInVuc2V0IiwicXVlcnlfc2VnbWVudCIsInBhcmFtZXRlciIsImlzUGxhaW5PYmplY3QiLCIkZGJfZnVuY3Rpb24iLCJmaWVsZFR5cGUiLCJnZXRfZmllbGRfdHlwZSIsInZhbGlkYXRvcnMiLCJnZXRfdmFsaWRhdG9ycyIsImlzQXJyYXkiLCJtYXAiLCJ2IiwiZGJWYWwiLCJ2YWxpZGF0aW9uTWVzc2FnZSIsImdldF92YWxpZGF0aW9uX21lc3NhZ2UiLCJjb3VudGVyUXVlcnlTZWdtZW50IiwiTWF0aCIsImFicyIsInVuc2V0X25vdF9hbGxvd2VkIiwib3BlcmF0aW9uIiwiaXNfcHJpbWFyeV9rZXlfZmllbGQiLCJpc19yZXF1aXJlZF9maWVsZCIsImdldF9pbnBsYWNlX3VwZGF0ZV9leHByZXNzaW9uIiwidXBkYXRlQ2xhdXNlcyIsInF1ZXJ5UGFyYW1zIiwiJGFkZCIsIiRhcHBlbmQiLCIkcHJlcGVuZCIsIiRyZXBsYWNlIiwiJHJlbW92ZSIsImluY2x1ZGVzIiwiT2JqZWN0Iiwia2V5cyIsInJlcGxhY2VLZXlzIiwicmVwbGFjZVZhbHVlcyIsInZhbHVlcyIsImdldF91cGRhdGVfdmFsdWVfZXhwcmVzc2lvbiIsImluc3RhbmNlIiwidXBkYXRlVmFsdWVzIiwib3B0aW9ucyIsInRpbWVzdGFtcHMiLCJ1cGRhdGVkQXQiLCJ2ZXJzaW9ucyIsImtleSIsImVycm9ySGFwcGVuZWQiLCJzb21lIiwidW5kZWZpbmVkIiwidmlydHVhbCIsIl9nZXRfZGVmYXVsdF92YWx1ZSIsInJ1bGUiLCJpZ25vcmVfZGVmYXVsdCIsInZhbGlkYXRlIiwiZ2V0X3NhdmVfdmFsdWVfZXhwcmVzc2lvbiIsImZuIiwiaWRlbnRpZmllcnMiLCJleHRyYWN0X3F1ZXJ5X3JlbGF0aW9ucyIsInJlbGF0aW9uS2V5IiwicmVsYXRpb25WYWx1ZSIsInZhbGlkT3BlcmF0b3JzIiwicXVlcnlSZWxhdGlvbnMiLCJ0b0xvd2VyQ2FzZSIsIm9wZXJhdG9yIiwid2hlcmVUZW1wbGF0ZSIsImJ1aWxkUXVlcnlSZWxhdGlvbnMiLCJmaWVsZE5hbWVMb2NhbCIsInJlbGF0aW9uVmFsdWVMb2NhbCIsImJ1aWxkVG9rZW5RdWVyeVJlbGF0aW9ucyIsInRva2VuUmVsYXRpb25LZXkiLCJ0b2tlblJlbGF0aW9uVmFsdWUiLCJ0b2tlbktleXMiLCJ0b2tlbkluZGV4IiwidHJpbSIsImpvaW4iLCJ0b1N0cmluZyIsInRva2VuUmVsYXRpb25LZXlzIiwidG9rZW5SSyIsImZpZWxkVHlwZTEiLCJmaWVsZFR5cGUyIiwiX3BhcnNlX3F1ZXJ5X29iamVjdCIsInF1ZXJ5T2JqZWN0Iiwic3RhcnRzV2l0aCIsInF1ZXJ5Iiwid2hlcmVPYmplY3QiLCJmayIsImZpZWxkUmVsYXRpb24iLCJjcWxPcGVyYXRvcnMiLCIkZXEiLCIkbmUiLCIkaXNudCIsIiRndCIsIiRsdCIsIiRndGUiLCIkbHRlIiwiJGluIiwiJGxpa2UiLCIkdG9rZW4iLCIkY29udGFpbnMiLCIkY29udGFpbnNfa2V5IiwidmFsaWRLZXlzIiwiZmllbGRSZWxhdGlvbktleXMiLCJyZWxhdGlvbktleXMiLCJyayIsImV4dHJhY3RlZFJlbGF0aW9ucyIsImNvbmNhdCIsImdldF9maWx0ZXJfY2xhdXNlIiwiY2xhdXNlIiwicGFyc2VkT2JqZWN0IiwiZmlsdGVyQ2xhdXNlIiwiZ2V0X2ZpbHRlcl9jbGF1c2VfZGRsIiwiZmlsdGVyUXVlcnkiLCJwYXJhbSIsInF1ZXJ5UGFyYW0iLCJEYXRlIiwidG9JU09TdHJpbmciLCJMb25nIiwiSW50ZWdlciIsIkJpZ0RlY2ltYWwiLCJUaW1lVXVpZCIsIlV1aWQiLCJMb2NhbERhdGUiLCJMb2NhbFRpbWUiLCJJbmV0QWRkcmVzcyIsImdldF93aGVyZV9jbGF1c2UiLCJnZXRfaWZfY2xhdXNlIiwiZ2V0X3ByaW1hcnlfa2V5X2NsYXVzZXMiLCJwYXJ0aXRpb25LZXkiLCJjbHVzdGVyaW5nS2V5Iiwic2xpY2UiLCJjbHVzdGVyaW5nT3JkZXIiLCJmaWVsZCIsImNsdXN0ZXJpbmdfb3JkZXIiLCJjbHVzdGVyaW5nT3JkZXJDbGF1c2UiLCJwYXJ0aXRpb25LZXlDbGF1c2UiLCJjbHVzdGVyaW5nS2V5Q2xhdXNlIiwiZ2V0X212aWV3X3doZXJlX2NsYXVzZSIsInZpZXdTY2hlbWEiLCJjbGF1c2VzIiwid2hlcmVDbGF1c2UiLCJmaWx0ZXJzIiwiY2xvbmVEZWVwIiwiZmlsdGVyS2V5IiwicXVvdGVkRmllbGROYW1lcyIsInVucXVvdGVkRmllbGROYW1lIiwicmVzZXJ2ZWRLZXl3b3JkcyIsInRvVXBwZXJDYXNlIiwiZ2V0X29yZGVyYnlfY2xhdXNlIiwib3JkZXJLZXlzIiwiayIsInF1ZXJ5SXRlbSIsIm9yZGVySXRlbUtleXMiLCJjcWxPcmRlckRpcmVjdGlvbiIsIiRhc2MiLCIkZGVzYyIsIm9yZGVyRmllbGRzIiwiaiIsImdldF9ncm91cGJ5X2NsYXVzZSIsImdyb3VwYnlLZXlzIiwiQXJyYXkiLCJnZXRfbGltaXRfY2xhdXNlIiwibGltaXQiLCJnZXRfc2VsZWN0X2NsYXVzZSIsInNlbGVjdENsYXVzZSIsInNlbGVjdCIsInNlbGVjdEFycmF5Iiwic2VsZWN0aW9uIiwiZmlsdGVyIiwic2VsZWN0aW9uRW5kQ2h1bmsiLCJzcGxpY2UiLCJzZWxlY3Rpb25DaHVuayIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7O0FBQUEsSUFBTUEsVUFBVUMsUUFBUSxVQUFSLENBQWhCO0FBQ0EsSUFBTUMsSUFBSUQsUUFBUSxRQUFSLENBQVY7QUFDQSxJQUFNRSxPQUFPRixRQUFRLE1BQVIsQ0FBYjs7QUFFQSxJQUFJRyxrQkFBSjtBQUNBLElBQUk7QUFDRjtBQUNBQSxjQUFZSCxRQUFRLFlBQVIsQ0FBWjtBQUNELENBSEQsQ0FHRSxPQUFPSSxDQUFQLEVBQVU7QUFDVkQsY0FBWSxJQUFaO0FBQ0Q7O0FBRUQsSUFBTUUsTUFBTU4sUUFBUU8sWUFBUixDQUFxQkgsYUFBYUgsUUFBUSxrQkFBUixDQUFsQyxDQUFaOztBQUVBLElBQU1PLGFBQWFQLFFBQVEsd0JBQVIsQ0FBbkI7QUFDQSxJQUFNUSxZQUFZUixRQUFRLHlCQUFSLENBQWxCO0FBQ0EsSUFBTVMsVUFBVVQsUUFBUSxzQkFBUixDQUFoQjs7QUFFQSxJQUFNVSxTQUFTLEVBQWY7QUFDQSxJQUFNQyxZQUFZLFNBQVpBLFNBQVksQ0FBQ0MsR0FBRCxFQUFLQyxLQUFMLEVBQVlDLEdBQVo7QUFBQSxTQUFvQkYsSUFBSUcsTUFBSixDQUFXLENBQVgsRUFBYUYsS0FBYixJQUFzQkMsR0FBdEIsR0FBNEJGLElBQUlHLE1BQUosQ0FBV0YsUUFBTSxDQUFqQixDQUFoRDtBQUFBLENBQWxCOztBQUVBSCxPQUFPTSxzQkFBUCxHQUFnQyxTQUFTQyxDQUFULENBQVdDLFlBQVgsRUFB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VixDQUFpQixDQUFqQixFQUFvQi9GLElBQXBCLENBQXlCLEtBQXpCLENBQWdDLEdBQXhFLENBQWpCO0FBQ0Q7QUFDRDJGLG9CQUFZcE0sSUFBWixDQUFpQmIsT0FBT00sc0JBQVAsQ0FBOEIsWUFBOUIsRUFBNENnTixjQUE1QyxFQUE0REYsa0JBQWtCLENBQWxCLENBQTVELENBQWpCO0FBQ0QsT0FYTSxNQVdBLElBQUlGLFVBQVVoTSxNQUFWLElBQW9CLENBQXhCLEVBQTJCO0FBQ2hDK0wsb0JBQVlwTSxJQUFaLENBQWlCckIsS0FBSzZCLE1BQUwsQ0FBWSxRQUFaLEVBQXNCNkwsVUFBVSxDQUFWLENBQXRCLEVBQXFDLElBQUdBLFVBQVVHLE1BQVYsQ0FBaUIsQ0FBakIsRUFBb0IvRixJQUFwQixDQUF5QixLQUF6QixDQUFnQyxHQUF4RSxDQUFqQjtBQUNEO0FBQ0Y7QUFDRHlGLG1CQUFlRSxZQUFZM0YsSUFBWixDQUFpQixHQUFqQixDQUFmO0FBQ0Q7QUFDRCxTQUFPeUYsWUFBUDtBQUNELENBOUJEOztBQWdDQVEsT0FBT0MsT0FBUCxHQUFpQnhOLE1BQWpCIiwiZmlsZSI6InBhcnNlci5qcyIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IFByb21pc2UgPSByZXF1aXJlKCdibHVlYmlyZCcpO1xuY29uc3QgXyA9IHJlcXVpcmUoJ2xvZGFzaCcpO1xuY29uc3QgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcblxubGV0IGRzZURyaXZlcjtcbnRyeSB7XG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBpbXBvcnQvbm8tZXh0cmFuZW91cy1kZXBlbmRlbmNpZXMsIGltcG9ydC9uby11bnJlc29sdmVkXG4gIGRzZURyaXZlciA9IHJlcXVpcmUoJ2RzZS1kcml2ZXInKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZHNlRHJpdmVyID0gbnVsbDtcbn1cblxuY29uc3QgY3FsID0gUHJvbWlzZS5wcm9taXNpZnlBbGwoZHNlRHJpdmVyIHx8IHJlcXVpcmUoJ2Nhc3NhbmRyYS1kcml2ZXInKSk7XG5cbmNvbnN0IGJ1aWxkRXJyb3IgPSByZXF1aXJlKCcuLi9vcm0vYXBvbGxvX2Vycm9yLmpzJyk7XG5jb25zdCBkYXRhdHlwZXMgPSByZXF1aXJlKCcuLi92YWxpZGF0b3JzL2RhdGF0eXBlcycpO1xuY29uc3Qgc2NoZW1lciA9IHJlcXVpcmUoJy4uL3ZhbGlkYXRvcnMvc2NoZW1hJyk7XG5cbmNvbnN0IHBhcnNlciA9IHt9O1xuY29uc3Qgc2V0Q2hhckF0ID0gKHN0cixpbmRleCwgY2hyKSA9PiBzdHIuc3Vic3RyKDAsaW5kZXgpICsgY2hyICsgc3RyLnN1YnN0cihpbmRleCsxKTtcblxucGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUgPSBmdW5jdGlvbiBmKGZvcm1hdFN0cmluZywgLi4ucGFyYW1zKXtcblxuICBjb25zdCBwbGFjZWhvbGRlcnMgPSBbXTtcblxuICBjb25zdCByZSA9IC8lLi9nO1xuICBsZXQgbWF0Y2g7XG4gIGRvIHtcbiAgICAgIG1hdGNoID0gcmUuZXhlYyhmb3JtYXRTdHJpbmcpO1xuICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgICAgcGxhY2Vob2xkZXJzLnB1c2gobWF0Y2gpXG4gICAgICB9XG4gIH0gd2hpbGUgKG1hdGNoKTtcblxuICAocGFyYW1zIHx8IFtdKS5mb3JFYWNoKChwLGkpID0+IHtcbiAgICBpZihpIDwgcGxhY2Vob2xkZXJzLmxlbmd0aCAmJiB0eXBlb2YocCkgPT09IFwic3RyaW5nXCIgJiYgcC5pbmRleE9mKFwiLT5cIikgIT09IC0xKXtcbiAgICAgIGNvbnN0IGZwID0gcGxhY2Vob2xkZXJzW2ldO1xuICAgICAgaWYoXG4gICAgICAgIGZwLmluZGV4ID4gMCAmJlxuICAgICAgICBmb3JtYXRTdHJpbmcubGVuZ3RoID4gZnAuaW5kZXgrMiAmJlxuICAgICAgICBmb3JtYXRTdHJpbmdbZnAuaW5kZXgtMV0gPT09ICdcIicgJiZcbiAgICAgICAgZm9ybWF0U3RyaW5nW2ZwLmluZGV4KzJdID09PSAnXCInXG4gICAgICApe1xuICAgICAgICBmb3JtYXRTdHJpbmcgPSBzZXRDaGFyQXQoZm9ybWF0U3RyaW5nLCBmcC5pbmRleC0xLCBcIiBcIik7XG4gICAgICAgIGZvcm1hdFN0cmluZyA9IHNldENoYXJBdChmb3JtYXRTdHJpbmcsIGZwLmluZGV4KzIsIFwiIFwiKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiB1dGlsLmZvcm1hdChmb3JtYXRTdHJpbmcsIC4uLnBhcmFtcyk7XG59XG5cbnBhcnNlci5jYWxsYmFja19vcl90aHJvdyA9IGZ1bmN0aW9uIGYoZXJyLCBjYWxsYmFjaykge1xuICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2FsbGJhY2soZXJyKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdGhyb3cgKGVycik7XG59O1xuXG5wYXJzZXIuZXh0cmFjdF90eXBlID0gZnVuY3Rpb24gZih2YWwpIHtcbiAgLy8gZGVjb21wb3NlIGNvbXBvc2l0ZSB0eXBlc1xuICBjb25zdCBkZWNvbXBvc2VkID0gdmFsID8gdmFsLnJlcGxhY2UoL1tcXHNdL2csICcnKS5zcGxpdCgvWzwsPl0vZykgOiBbJyddO1xuXG4gIGZvciAobGV0IGQgPSAwOyBkIDwgZGVjb21wb3NlZC5sZW5ndGg7IGQrKykge1xuICAgIGlmIChfLmhhcyhkYXRhdHlwZXMsIGRlY29tcG9zZWRbZF0pKSB7XG4gICAgICByZXR1cm4gZGVjb21wb3NlZFtkXTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdmFsO1xufTtcblxucGFyc2VyLmV4dHJhY3RfdHlwZURlZiA9IGZ1bmN0aW9uIGYodmFsKSB7XG4gIC8vIGRlY29tcG9zZSBjb21wb3NpdGUgdHlwZXNcbiAgbGV0IGRlY29tcG9zZWQgPSB2YWwgPyB2YWwucmVwbGFjZSgvW1xcc10vZywgJycpIDogJyc7XG4gIGRlY29tcG9zZWQgPSBkZWNvbXBvc2VkLnN1YnN0cihkZWNvbXBvc2VkLmluZGV4T2YoJzwnKSwgZGVjb21wb3NlZC5sZW5ndGggLSBkZWNvbXBvc2VkLmluZGV4T2YoJzwnKSk7XG5cbiAgcmV0dXJuIGRlY29tcG9zZWQ7XG59O1xuXG5wYXJzZXIuZXh0cmFjdF9hbHRlcmVkX3R5cGUgPSBmdW5jdGlvbiBmKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSwgZGlmZikge1xuICBjb25zdCBmaWVsZE5hbWUgPSBkaWZmLnBhdGhbMF07XG4gIGxldCB0eXBlID0gJyc7XG4gIGlmIChkaWZmLnBhdGgubGVuZ3RoID4gMSkge1xuICAgIGlmIChkaWZmLnBhdGhbMV0gPT09ICd0eXBlJykge1xuICAgICAgdHlwZSA9IGRpZmYucmhzO1xuICAgICAgaWYgKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlRGVmKSB7XG4gICAgICAgIHR5cGUgKz0gbm9ybWFsaXplZE1vZGVsU2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGVEZWY7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHR5cGUgPSBub3JtYWxpemVkTW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZTtcbiAgICAgIHR5cGUgKz0gZGlmZi5yaHM7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHR5cGUgPSBkaWZmLnJocy50eXBlO1xuICAgIGlmIChkaWZmLnJocy50eXBlRGVmKSB0eXBlICs9IGRpZmYucmhzLnR5cGVEZWY7XG4gIH1cbiAgcmV0dXJuIHR5cGU7XG59O1xuXG5wYXJzZXIuZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24gPSBmdW5jdGlvbiBmKHNjaGVtYSwgZmllbGROYW1lLCBmaWVsZFZhbHVlKSB7XG4gIGlmIChmaWVsZFZhbHVlID09IG51bGwgfHwgZmllbGRWYWx1ZSA9PT0gY3FsLnR5cGVzLnVuc2V0KSB7XG4gICAgcmV0dXJuIHsgcXVlcnlfc2VnbWVudDogJzpib3VuZHBhcmFtJywgcGFyYW1ldGVyOiBmaWVsZFZhbHVlIH07XG4gIH1cblxuICBpZiAoXy5pc1BsYWluT2JqZWN0KGZpZWxkVmFsdWUpICYmIGZpZWxkVmFsdWUuJGRiX2Z1bmN0aW9uKSB7XG4gICAgcmV0dXJuIGZpZWxkVmFsdWUuJGRiX2Z1bmN0aW9uO1xuICB9XG5cbiAgY29uc3QgZmllbGRUeXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG4gIGNvbnN0IHZhbGlkYXRvcnMgPSBzY2hlbWVyLmdldF92YWxpZGF0b3JzKHNjaGVtYSwgZmllbGROYW1lKTtcblxuICBpZiAoXy5pc0FycmF5KGZpZWxkVmFsdWUpICYmIGZpZWxkVHlwZSAhPT0gJ2xpc3QnICYmIGZpZWxkVHlwZSAhPT0gJ3NldCcgJiYgZmllbGRUeXBlICE9PSAnZnJvemVuJykge1xuICAgIGNvbnN0IHZhbCA9IGZpZWxkVmFsdWUubWFwKCh2KSA9PiB7XG4gICAgICBjb25zdCBkYlZhbCA9IHBhcnNlci5nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihzY2hlbWEsIGZpZWxkTmFtZSwgdik7XG5cbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHJldHVybiBkYlZhbC5wYXJhbWV0ZXI7XG4gICAgICByZXR1cm4gZGJWYWw7XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBxdWVyeV9zZWdtZW50OiAnOmJvdW5kcGFyYW0nLCBwYXJhbWV0ZXI6IHZhbCB9O1xuICB9XG5cbiAgY29uc3QgdmFsaWRhdGlvbk1lc3NhZ2UgPSBzY2hlbWVyLmdldF92YWxpZGF0aW9uX21lc3NhZ2UodmFsaWRhdG9ycywgZmllbGRWYWx1ZSk7XG4gIGlmICh0eXBlb2YgdmFsaWRhdGlvbk1lc3NhZ2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWR2YWx1ZScsIHZhbGlkYXRpb25NZXNzYWdlKGZpZWxkVmFsdWUsIGZpZWxkTmFtZSwgZmllbGRUeXBlKSkpO1xuICB9XG5cbiAgaWYgKGZpZWxkVHlwZSA9PT0gJ2NvdW50ZXInKSB7XG4gICAgbGV0IGNvdW50ZXJRdWVyeVNlZ21lbnQgPSBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiJywgZmllbGROYW1lKTtcbiAgICBpZiAoZmllbGRWYWx1ZSA+PSAwKSBjb3VudGVyUXVlcnlTZWdtZW50ICs9ICcgKyA6Ym91bmRwYXJhbSc7XG4gICAgZWxzZSBjb3VudGVyUXVlcnlTZWdtZW50ICs9ICcgLSA6Ym91bmRwYXJhbSc7XG4gICAgZmllbGRWYWx1ZSA9IE1hdGguYWJzKGZpZWxkVmFsdWUpO1xuICAgIHJldHVybiB7IHF1ZXJ5X3NlZ21lbnQ6IGNvdW50ZXJRdWVyeVNlZ21lbnQsIHBhcmFtZXRlcjogZmllbGRWYWx1ZSB9O1xuICB9XG5cbiAgcmV0dXJuIHsgcXVlcnlfc2VnbWVudDogJzpib3VuZHBhcmFtJywgcGFyYW1ldGVyOiBmaWVsZFZhbHVlIH07XG59O1xuXG5wYXJzZXIudW5zZXRfbm90X2FsbG93ZWQgPSBmdW5jdGlvbiBmKG9wZXJhdGlvbiwgc2NoZW1hLCBmaWVsZE5hbWUsIGNhbGxiYWNrKSB7XG4gIGlmIChzY2hlbWVyLmlzX3ByaW1hcnlfa2V5X2ZpZWxkKHNjaGVtYSwgZmllbGROYW1lKSkge1xuICAgIHBhcnNlci5jYWxsYmFja19vcl90aHJvdyhidWlsZEVycm9yKGBtb2RlbC4ke29wZXJhdGlvbn0udW5zZXRrZXlgLCBmaWVsZE5hbWUpLCBjYWxsYmFjayk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgaWYgKHNjaGVtZXIuaXNfcmVxdWlyZWRfZmllbGQoc2NoZW1hLCBmaWVsZE5hbWUpKSB7XG4gICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGJ1aWxkRXJyb3IoYG1vZGVsLiR7b3BlcmF0aW9ufS51bnNldHJlcXVpcmVkYCwgZmllbGROYW1lKSwgY2FsbGJhY2spO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn07XG5cbnBhcnNlci5nZXRfaW5wbGFjZV91cGRhdGVfZXhwcmVzc2lvbiA9IGZ1bmN0aW9uIGYoc2NoZW1hLCBmaWVsZE5hbWUsIGZpZWxkVmFsdWUsIHVwZGF0ZUNsYXVzZXMsIHF1ZXJ5UGFyYW1zKSB7XG4gIGNvbnN0ICRhZGQgPSAoXy5pc1BsYWluT2JqZWN0KGZpZWxkVmFsdWUpICYmIGZpZWxkVmFsdWUuJGFkZCkgfHwgZmFsc2U7XG4gIGNvbnN0ICRhcHBlbmQgPSAoXy5pc1BsYWluT2JqZWN0KGZpZWxkVmFsdWUpICYmIGZpZWxkVmFsdWUuJGFwcGVuZCkgfHwgZmFsc2U7XG4gIGNvbnN0ICRwcmVwZW5kID0gKF8uaXNQbGFpbk9iamVjdChmaWVsZFZhbHVlKSAmJiBmaWVsZFZhbHVlLiRwcmVwZW5kKSB8fCBmYWxzZTtcbiAgY29uc3QgJHJlcGxhY2UgPSAoXy5pc1BsYWluT2JqZWN0KGZpZWxkVmFsdWUpICYmIGZpZWxkVmFsdWUuJHJlcGxhY2UpIHx8IGZhbHNlO1xuICBjb25zdCAkcmVtb3ZlID0gKF8uaXNQbGFpbk9iamVjdChmaWVsZFZhbHVlKSAmJiBmaWVsZFZhbHVlLiRyZW1vdmUpIHx8IGZhbHNlO1xuXG4gIGZpZWxkVmFsdWUgPSAkYWRkIHx8ICRhcHBlbmQgfHwgJHByZXBlbmQgfHwgJHJlcGxhY2UgfHwgJHJlbW92ZSB8fCBmaWVsZFZhbHVlO1xuXG4gIGNvbnN0IGRiVmFsID0gcGFyc2VyLmdldF9kYl92YWx1ZV9leHByZXNzaW9uKHNjaGVtYSwgZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcblxuICBpZiAoIV8uaXNQbGFpbk9iamVjdChkYlZhbCkgfHwgIWRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHtcbiAgICB1cGRhdGVDbGF1c2VzLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIj0lcycsIGZpZWxkTmFtZSwgZGJWYWwpKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBmaWVsZFR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwgZmllbGROYW1lKTtcblxuICBpZiAoWydtYXAnLCAnbGlzdCcsICdzZXQnXS5pbmNsdWRlcyhmaWVsZFR5cGUpKSB7XG4gICAgaWYgKCRhZGQgfHwgJGFwcGVuZCkge1xuICAgICAgZGJWYWwucXVlcnlfc2VnbWVudCA9IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCIgKyAlcycsIGZpZWxkTmFtZSwgZGJWYWwucXVlcnlfc2VnbWVudCk7XG4gICAgfSBlbHNlIGlmICgkcHJlcGVuZCkge1xuICAgICAgaWYgKGZpZWxkVHlwZSA9PT0gJ2xpc3QnKSB7XG4gICAgICAgIGRiVmFsLnF1ZXJ5X3NlZ21lbnQgPSBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnJXMgKyBcIiVzXCInLCBkYlZhbC5xdWVyeV9zZWdtZW50LCBmaWVsZE5hbWUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoXG4gICAgICAgICAgJ21vZGVsLnVwZGF0ZS5pbnZhbGlkcHJlcGVuZG9wJyxcbiAgICAgICAgICB1dGlsLmZvcm1hdCgnJXMgZGF0YXR5cGVzIGRvZXMgbm90IHN1cHBvcnQgJHByZXBlbmQsIHVzZSAkYWRkIGluc3RlYWQnLCBmaWVsZFR5cGUpLFxuICAgICAgICApKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKCRyZW1vdmUpIHtcbiAgICAgIGRiVmFsLnF1ZXJ5X3NlZ21lbnQgPSBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiIC0gJXMnLCBmaWVsZE5hbWUsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpO1xuICAgICAgaWYgKGZpZWxkVHlwZSA9PT0gJ21hcCcpIGRiVmFsLnBhcmFtZXRlciA9IE9iamVjdC5rZXlzKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgfVxuICB9XG5cbiAgaWYgKCRyZXBsYWNlKSB7XG4gICAgaWYgKGZpZWxkVHlwZSA9PT0gJ21hcCcpIHtcbiAgICAgIHVwZGF0ZUNsYXVzZXMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiWz9dPSVzJywgZmllbGROYW1lLCBkYlZhbC5xdWVyeV9zZWdtZW50KSk7XG4gICAgICBjb25zdCByZXBsYWNlS2V5cyA9IE9iamVjdC5rZXlzKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICBjb25zdCByZXBsYWNlVmFsdWVzID0gXy52YWx1ZXMoZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgIGlmIChyZXBsYWNlS2V5cy5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgcXVlcnlQYXJhbXMucHVzaChyZXBsYWNlS2V5c1swXSk7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2gocmVwbGFjZVZhbHVlc1swXSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyAoXG4gICAgICAgICAgYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmludmFsaWRyZXBsYWNlb3AnLCAnJHJlcGxhY2UgaW4gbWFwIGRvZXMgbm90IHN1cHBvcnQgbW9yZSB0aGFuIG9uZSBpdGVtJylcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKGZpZWxkVHlwZSA9PT0gJ2xpc3QnKSB7XG4gICAgICB1cGRhdGVDbGF1c2VzLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoJ1wiJXNcIls/XT0lcycsIGZpZWxkTmFtZSwgZGJWYWwucXVlcnlfc2VnbWVudCkpO1xuICAgICAgaWYgKGRiVmFsLnBhcmFtZXRlci5sZW5ndGggPT09IDIpIHtcbiAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXJbMF0pO1xuICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlclsxXSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcihcbiAgICAgICAgICAnbW9kZWwudXBkYXRlLmludmFsaWRyZXBsYWNlb3AnLFxuICAgICAgICAgICckcmVwbGFjZSBpbiBsaXN0IHNob3VsZCBoYXZlIGV4YWN0bHkgMiBpdGVtcywgZmlyc3Qgb25lIGFzIHRoZSBpbmRleCBhbmQgdGhlIHNlY29uZCBvbmUgYXMgdGhlIHZhbHVlJyxcbiAgICAgICAgKSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IChidWlsZEVycm9yKFxuICAgICAgICAnbW9kZWwudXBkYXRlLmludmFsaWRyZXBsYWNlb3AnLFxuICAgICAgICB1dGlsLmZvcm1hdCgnJXMgZGF0YXR5cGVzIGRvZXMgbm90IHN1cHBvcnQgJHJlcGxhY2UnLCBmaWVsZFR5cGUpLFxuICAgICAgKSk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHVwZGF0ZUNsYXVzZXMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiPSVzJywgZmllbGROYW1lLCBkYlZhbC5xdWVyeV9zZWdtZW50KSk7XG4gICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXIpO1xuICB9XG59O1xuXG5wYXJzZXIuZ2V0X3VwZGF0ZV92YWx1ZV9leHByZXNzaW9uID0gZnVuY3Rpb24gZihpbnN0YW5jZSwgc2NoZW1hLCB1cGRhdGVWYWx1ZXMsIGNhbGxiYWNrKSB7XG4gIGNvbnN0IHVwZGF0ZUNsYXVzZXMgPSBbXTtcbiAgY29uc3QgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBpZiAoc2NoZW1hLm9wdGlvbnMgJiYgc2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcykge1xuICAgIGlmICghdXBkYXRlVmFsdWVzW3NjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMudXBkYXRlZEF0XSkge1xuICAgICAgdXBkYXRlVmFsdWVzW3NjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMudXBkYXRlZEF0XSA9IHsgJGRiX2Z1bmN0aW9uOiAndG9UaW1lc3RhbXAobm93KCkpJyB9O1xuICAgIH1cbiAgfVxuXG4gIGlmIChzY2hlbWEub3B0aW9ucyAmJiBzY2hlbWEub3B0aW9ucy52ZXJzaW9ucykge1xuICAgIGlmICghdXBkYXRlVmFsdWVzW3NjaGVtYS5vcHRpb25zLnZlcnNpb25zLmtleV0pIHtcbiAgICAgIHVwZGF0ZVZhbHVlc1tzY2hlbWEub3B0aW9ucy52ZXJzaW9ucy5rZXldID0geyAkZGJfZnVuY3Rpb246ICdub3coKScgfTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBlcnJvckhhcHBlbmVkID0gT2JqZWN0LmtleXModXBkYXRlVmFsdWVzKS5zb21lKChmaWVsZE5hbWUpID0+IHtcbiAgICBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdID09PSB1bmRlZmluZWQgfHwgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnZpcnR1YWwpIHJldHVybiBmYWxzZTtcblxuICAgIGNvbnN0IGZpZWxkVHlwZSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBmaWVsZE5hbWUpO1xuICAgIGxldCBmaWVsZFZhbHVlID0gdXBkYXRlVmFsdWVzW2ZpZWxkTmFtZV07XG5cbiAgICBpZiAoZmllbGRWYWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBmaWVsZFZhbHVlID0gaW5zdGFuY2UuX2dldF9kZWZhdWx0X3ZhbHVlKGZpZWxkTmFtZSk7XG4gICAgICBpZiAoZmllbGRWYWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJldHVybiBwYXJzZXIudW5zZXRfbm90X2FsbG93ZWQoJ3VwZGF0ZScsIHNjaGVtYSwgZmllbGROYW1lLCBjYWxsYmFjayk7XG4gICAgICB9IGVsc2UgaWYgKCFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0ucnVsZSB8fCAhc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnJ1bGUuaWdub3JlX2RlZmF1bHQpIHtcbiAgICAgICAgLy8gZGlkIHNldCBhIGRlZmF1bHQgdmFsdWUsIGlnbm9yZSBkZWZhdWx0IGlzIG5vdCBzZXRcbiAgICAgICAgaWYgKGluc3RhbmNlLnZhbGlkYXRlKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSkgIT09IHRydWUpIHtcbiAgICAgICAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmludmFsaWRkZWZhdWx0dmFsdWUnLCBmaWVsZFZhbHVlLCBmaWVsZE5hbWUsIGZpZWxkVHlwZSksIGNhbGxiYWNrKTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChmaWVsZFZhbHVlID09PSBudWxsIHx8IGZpZWxkVmFsdWUgPT09IGNxbC50eXBlcy51bnNldCkge1xuICAgICAgaWYgKHBhcnNlci51bnNldF9ub3RfYWxsb3dlZCgndXBkYXRlJywgc2NoZW1hLCBmaWVsZE5hbWUsIGNhbGxiYWNrKSkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgcGFyc2VyLmdldF9pbnBsYWNlX3VwZGF0ZV9leHByZXNzaW9uKHNjaGVtYSwgZmllbGROYW1lLCBmaWVsZFZhbHVlLCB1cGRhdGVDbGF1c2VzLCBxdWVyeVBhcmFtcyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGUsIGNhbGxiYWNrKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH0pO1xuXG4gIHJldHVybiB7IHVwZGF0ZUNsYXVzZXMsIHF1ZXJ5UGFyYW1zLCBlcnJvckhhcHBlbmVkIH07XG59O1xuXG5wYXJzZXIuZ2V0X3NhdmVfdmFsdWVfZXhwcmVzc2lvbiA9IGZ1bmN0aW9uIGZuKGluc3RhbmNlLCBzY2hlbWEsIGNhbGxiYWNrKSB7XG4gIGNvbnN0IGlkZW50aWZpZXJzID0gW107XG4gIGNvbnN0IHZhbHVlcyA9IFtdO1xuICBjb25zdCBxdWVyeVBhcmFtcyA9IFtdO1xuXG4gIGlmIChzY2hlbWEub3B0aW9ucyAmJiBzY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzKSB7XG4gICAgaWYgKGluc3RhbmNlW3NjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMudXBkYXRlZEF0XSkge1xuICAgICAgaW5zdGFuY2Vbc2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy51cGRhdGVkQXRdID0geyAkZGJfZnVuY3Rpb246ICd0b1RpbWVzdGFtcChub3coKSknIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKHNjaGVtYS5vcHRpb25zICYmIHNjaGVtYS5vcHRpb25zLnZlcnNpb25zKSB7XG4gICAgaWYgKGluc3RhbmNlW3NjaGVtYS5vcHRpb25zLnZlcnNpb25zLmtleV0pIHtcbiAgICAgIGluc3RhbmNlW3NjaGVtYS5vcHRpb25zLnZlcnNpb25zLmtleV0gPSB7ICRkYl9mdW5jdGlvbjogJ25vdygpJyB9O1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGVycm9ySGFwcGVuZWQgPSBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKS5zb21lKChmaWVsZE5hbWUpID0+IHtcbiAgICBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnZpcnR1YWwpIHJldHVybiBmYWxzZTtcblxuICAgIC8vIGNoZWNrIGZpZWxkIHZhbHVlXG4gICAgY29uc3QgZmllbGRUeXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGZpZWxkTmFtZSk7XG4gICAgbGV0IGZpZWxkVmFsdWUgPSBpbnN0YW5jZVtmaWVsZE5hbWVdO1xuXG4gICAgaWYgKGZpZWxkVmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZmllbGRWYWx1ZSA9IGluc3RhbmNlLl9nZXRfZGVmYXVsdF92YWx1ZShmaWVsZE5hbWUpO1xuICAgICAgaWYgKGZpZWxkVmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXR1cm4gcGFyc2VyLnVuc2V0X25vdF9hbGxvd2VkKCdzYXZlJywgc2NoZW1hLCBmaWVsZE5hbWUsIGNhbGxiYWNrKTtcbiAgICAgIH0gZWxzZSBpZiAoIXNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5ydWxlIHx8ICFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0ucnVsZS5pZ25vcmVfZGVmYXVsdCkge1xuICAgICAgICAvLyBkaWQgc2V0IGEgZGVmYXVsdCB2YWx1ZSwgaWdub3JlIGRlZmF1bHQgaXMgbm90IHNldFxuICAgICAgICBpZiAoaW5zdGFuY2UudmFsaWRhdGUoZmllbGROYW1lLCBmaWVsZFZhbHVlKSAhPT0gdHJ1ZSkge1xuICAgICAgICAgIHBhcnNlci5jYWxsYmFja19vcl90aHJvdyhidWlsZEVycm9yKCdtb2RlbC5zYXZlLmludmFsaWRkZWZhdWx0dmFsdWUnLCBmaWVsZFZhbHVlLCBmaWVsZE5hbWUsIGZpZWxkVHlwZSksIGNhbGxiYWNrKTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChmaWVsZFZhbHVlID09PSBudWxsIHx8IGZpZWxkVmFsdWUgPT09IGNxbC50eXBlcy51bnNldCkge1xuICAgICAgaWYgKHBhcnNlci51bnNldF9ub3RfYWxsb3dlZCgnc2F2ZScsIHNjaGVtYSwgZmllbGROYW1lLCBjYWxsYmFjaykpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWRlbnRpZmllcnMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiJywgZmllbGROYW1lKSk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgZGJWYWwgPSBwYXJzZXIuZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24oc2NoZW1hLCBmaWVsZE5hbWUsIGZpZWxkVmFsdWUpO1xuICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgICAgICB2YWx1ZXMucHVzaChkYlZhbC5xdWVyeV9zZWdtZW50KTtcbiAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFsdWVzLnB1c2goZGJWYWwpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHBhcnNlci5jYWxsYmFja19vcl90aHJvdyhlLCBjYWxsYmFjayk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9KTtcblxuICByZXR1cm4ge1xuICAgIGlkZW50aWZpZXJzLFxuICAgIHZhbHVlcyxcbiAgICBxdWVyeVBhcmFtcyxcbiAgICBlcnJvckhhcHBlbmVkLFxuICB9O1xufTtcblxucGFyc2VyLmV4dHJhY3RfcXVlcnlfcmVsYXRpb25zID0gZnVuY3Rpb24gZihmaWVsZE5hbWUsIHJlbGF0aW9uS2V5LCByZWxhdGlvblZhbHVlLCBzY2hlbWEsIHZhbGlkT3BlcmF0b3JzKSB7XG4gIGNvbnN0IHF1ZXJ5UmVsYXRpb25zID0gW107XG4gIGNvbnN0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgaWYgKCFfLmhhcyh2YWxpZE9wZXJhdG9ycywgcmVsYXRpb25LZXkudG9Mb3dlckNhc2UoKSkpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkb3AnLCByZWxhdGlvbktleSkpO1xuICB9XG5cbiAgcmVsYXRpb25LZXkgPSByZWxhdGlvbktleS50b0xvd2VyQ2FzZSgpO1xuICBpZiAocmVsYXRpb25LZXkgPT09ICckaW4nICYmICFfLmlzQXJyYXkocmVsYXRpb25WYWx1ZSkpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkaW5vcCcpKTtcbiAgfVxuICBpZiAocmVsYXRpb25LZXkgPT09ICckdG9rZW4nICYmICEocmVsYXRpb25WYWx1ZSBpbnN0YW5jZW9mIE9iamVjdCkpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkdG9rZW4nKSk7XG4gIH1cblxuICBsZXQgb3BlcmF0b3IgPSB2YWxpZE9wZXJhdG9yc1tyZWxhdGlvbktleV07XG4gIGxldCB3aGVyZVRlbXBsYXRlID0gJ1wiJXNcIiAlcyAlcyc7XG5cbiAgY29uc3QgYnVpbGRRdWVyeVJlbGF0aW9ucyA9IChmaWVsZE5hbWVMb2NhbCwgcmVsYXRpb25WYWx1ZUxvY2FsKSA9PiB7XG4gICAgY29uc3QgZGJWYWwgPSBwYXJzZXIuZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24oc2NoZW1hLCBmaWVsZE5hbWVMb2NhbCwgcmVsYXRpb25WYWx1ZUxvY2FsKTtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGRiVmFsKSAmJiBkYlZhbC5xdWVyeV9zZWdtZW50KSB7XG4gICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKFxuICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICBmaWVsZE5hbWVMb2NhbCwgb3BlcmF0b3IsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQsXG4gICAgICApKTtcbiAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZShcbiAgICAgICAgd2hlcmVUZW1wbGF0ZSxcbiAgICAgICAgZmllbGROYW1lTG9jYWwsIG9wZXJhdG9yLCBkYlZhbCxcbiAgICAgICkpO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBidWlsZFRva2VuUXVlcnlSZWxhdGlvbnMgPSAodG9rZW5SZWxhdGlvbktleSwgdG9rZW5SZWxhdGlvblZhbHVlKSA9PiB7XG4gICAgdG9rZW5SZWxhdGlvbktleSA9IHRva2VuUmVsYXRpb25LZXkudG9Mb3dlckNhc2UoKTtcbiAgICBpZiAoXy5oYXModmFsaWRPcGVyYXRvcnMsIHRva2VuUmVsYXRpb25LZXkpICYmIHRva2VuUmVsYXRpb25LZXkgIT09ICckdG9rZW4nICYmIHRva2VuUmVsYXRpb25LZXkgIT09ICckaW4nKSB7XG4gICAgICBvcGVyYXRvciA9IHZhbGlkT3BlcmF0b3JzW3Rva2VuUmVsYXRpb25LZXldO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkdG9rZW5vcCcsIHRva2VuUmVsYXRpb25LZXkpKTtcbiAgICB9XG5cbiAgICBpZiAoXy5pc0FycmF5KHRva2VuUmVsYXRpb25WYWx1ZSkpIHtcbiAgICAgIGNvbnN0IHRva2VuS2V5cyA9IGZpZWxkTmFtZS5zcGxpdCgnLCcpO1xuICAgICAgZm9yIChsZXQgdG9rZW5JbmRleCA9IDA7IHRva2VuSW5kZXggPCB0b2tlblJlbGF0aW9uVmFsdWUubGVuZ3RoOyB0b2tlbkluZGV4KyspIHtcbiAgICAgICAgdG9rZW5LZXlzW3Rva2VuSW5kZXhdID0gdG9rZW5LZXlzW3Rva2VuSW5kZXhdLnRyaW0oKTtcbiAgICAgICAgY29uc3QgZGJWYWwgPSBwYXJzZXIuZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24oc2NoZW1hLCB0b2tlbktleXNbdG9rZW5JbmRleF0sIHRva2VuUmVsYXRpb25WYWx1ZVt0b2tlbkluZGV4XSk7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHtcbiAgICAgICAgICB0b2tlblJlbGF0aW9uVmFsdWVbdG9rZW5JbmRleF0gPSBkYlZhbC5xdWVyeV9zZWdtZW50O1xuICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0b2tlblJlbGF0aW9uVmFsdWVbdG9rZW5JbmRleF0gPSBkYlZhbDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgd2hlcmVUZW1wbGF0ZSxcbiAgICAgICAgdG9rZW5LZXlzLmpvaW4oJ1wiLFwiJyksIG9wZXJhdG9yLCB0b2tlblJlbGF0aW9uVmFsdWUudG9TdHJpbmcoKSxcbiAgICAgICkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBidWlsZFF1ZXJ5UmVsYXRpb25zKGZpZWxkTmFtZSwgdG9rZW5SZWxhdGlvblZhbHVlKTtcbiAgICB9XG4gIH07XG5cbiAgaWYgKHJlbGF0aW9uS2V5ID09PSAnJHRva2VuJykge1xuICAgIHdoZXJlVGVtcGxhdGUgPSAndG9rZW4oXCIlc1wiKSAlcyB0b2tlbiglcyknO1xuXG4gICAgY29uc3QgdG9rZW5SZWxhdGlvbktleXMgPSBPYmplY3Qua2V5cyhyZWxhdGlvblZhbHVlKTtcbiAgICBmb3IgKGxldCB0b2tlblJLID0gMDsgdG9rZW5SSyA8IHRva2VuUmVsYXRpb25LZXlzLmxlbmd0aDsgdG9rZW5SSysrKSB7XG4gICAgICBjb25zdCB0b2tlblJlbGF0aW9uS2V5ID0gdG9rZW5SZWxhdGlvbktleXNbdG9rZW5SS107XG4gICAgICBjb25zdCB0b2tlblJlbGF0aW9uVmFsdWUgPSByZWxhdGlvblZhbHVlW3Rva2VuUmVsYXRpb25LZXldO1xuICAgICAgYnVpbGRUb2tlblF1ZXJ5UmVsYXRpb25zKHRva2VuUmVsYXRpb25LZXksIHRva2VuUmVsYXRpb25WYWx1ZSk7XG4gICAgfVxuICB9IGVsc2UgaWYgKHJlbGF0aW9uS2V5ID09PSAnJGNvbnRhaW5zJykge1xuICAgIGNvbnN0IGZpZWxkVHlwZTEgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwgZmllbGROYW1lKTtcbiAgICBpZiAoWydtYXAnLCAnbGlzdCcsICdzZXQnLCAnZnJvemVuJ10uaW5jbHVkZXMoZmllbGRUeXBlMSkpIHtcbiAgICAgIGlmIChmaWVsZFR5cGUxID09PSAnbWFwJyAmJiBfLmlzUGxhaW5PYmplY3QocmVsYXRpb25WYWx1ZSkpIHtcbiAgICAgICAgT2JqZWN0LmtleXMocmVsYXRpb25WYWx1ZSkuZm9yRWFjaCgoa2V5KSA9PiB7XG4gICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaChwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZShcbiAgICAgICAgICAgICdcIiVzXCJbJXNdICVzICVzJyxcbiAgICAgICAgICAgIGZpZWxkTmFtZSwgJz8nLCAnPScsICc/JyxcbiAgICAgICAgICApKTtcbiAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGtleSk7XG4gICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChyZWxhdGlvblZhbHVlW2tleV0pO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoXG4gICAgICAgICAgd2hlcmVUZW1wbGF0ZSxcbiAgICAgICAgICBmaWVsZE5hbWUsIG9wZXJhdG9yLCAnPycsXG4gICAgICAgICkpO1xuICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKHJlbGF0aW9uVmFsdWUpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkY29udGFpbnNvcCcpKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAocmVsYXRpb25LZXkgPT09ICckY29udGFpbnNfa2V5Jykge1xuICAgIGNvbnN0IGZpZWxkVHlwZTIgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwgZmllbGROYW1lKTtcbiAgICBpZiAoZmllbGRUeXBlMiAhPT0gJ21hcCcpIHtcbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRjb250YWluc2tleW9wJykpO1xuICAgIH1cbiAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgd2hlcmVUZW1wbGF0ZSxcbiAgICAgIGZpZWxkTmFtZSwgb3BlcmF0b3IsICc/JyxcbiAgICApKTtcbiAgICBxdWVyeVBhcmFtcy5wdXNoKHJlbGF0aW9uVmFsdWUpO1xuICB9IGVsc2Uge1xuICAgIGJ1aWxkUXVlcnlSZWxhdGlvbnMoZmllbGROYW1lLCByZWxhdGlvblZhbHVlKTtcbiAgfVxuICByZXR1cm4geyBxdWVyeVJlbGF0aW9ucywgcXVlcnlQYXJhbXMgfTtcbn07XG5cbnBhcnNlci5fcGFyc2VfcXVlcnlfb2JqZWN0ID0gZnVuY3Rpb24gZihzY2hlbWEsIHF1ZXJ5T2JqZWN0KSB7XG4gIGxldCBxdWVyeVJlbGF0aW9ucyA9IFtdO1xuICBsZXQgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBPYmplY3Qua2V5cyhxdWVyeU9iamVjdCkuZm9yRWFjaCgoZmllbGROYW1lKSA9PiB7XG4gICAgaWYgKGZpZWxkTmFtZS5zdGFydHNXaXRoKCckJykpIHtcbiAgICAgIC8vIHNlYXJjaCBxdWVyaWVzIGJhc2VkIG9uIGx1Y2VuZSBpbmRleCBvciBzb2xyXG4gICAgICAvLyBlc2NhcGUgYWxsIHNpbmdsZSBxdW90ZXMgZm9yIHF1ZXJpZXMgaW4gY2Fzc2FuZHJhXG4gICAgICBpZiAoZmllbGROYW1lID09PSAnJGV4cHInKSB7XG4gICAgICAgIGlmICh0eXBlb2YgcXVlcnlPYmplY3RbZmllbGROYW1lXS5pbmRleCA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIHF1ZXJ5T2JqZWN0W2ZpZWxkTmFtZV0ucXVlcnkgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgIFwiZXhwciglcywnJXMnKVwiLFxuICAgICAgICAgICAgcXVlcnlPYmplY3RbZmllbGROYW1lXS5pbmRleCwgcXVlcnlPYmplY3RbZmllbGROYW1lXS5xdWVyeS5yZXBsYWNlKC8nL2csIFwiJydcIiksXG4gICAgICAgICAgKSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZGV4cHInKSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoZmllbGROYW1lID09PSAnJHNvbHJfcXVlcnknKSB7XG4gICAgICAgIGlmICh0eXBlb2YgcXVlcnlPYmplY3RbZmllbGROYW1lXSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgXCJzb2xyX3F1ZXJ5PSclcydcIixcbiAgICAgICAgICAgIHF1ZXJ5T2JqZWN0W2ZpZWxkTmFtZV0ucmVwbGFjZSgvJy9nLCBcIicnXCIpLFxuICAgICAgICAgICkpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRzb2xycXVlcnknKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBsZXQgd2hlcmVPYmplY3QgPSBxdWVyeU9iamVjdFtmaWVsZE5hbWVdO1xuICAgIC8vIEFycmF5IG9mIG9wZXJhdG9yc1xuICAgIGlmICghXy5pc0FycmF5KHdoZXJlT2JqZWN0KSkgd2hlcmVPYmplY3QgPSBbd2hlcmVPYmplY3RdO1xuXG4gICAgZm9yIChsZXQgZmsgPSAwOyBmayA8IHdoZXJlT2JqZWN0Lmxlbmd0aDsgZmsrKykge1xuICAgICAgbGV0IGZpZWxkUmVsYXRpb24gPSB3aGVyZU9iamVjdFtma107XG5cbiAgICAgIGNvbnN0IGNxbE9wZXJhdG9ycyA9IHtcbiAgICAgICAgJGVxOiAnPScsXG4gICAgICAgICRuZTogJyE9JyxcbiAgICAgICAgJGlzbnQ6ICdJUyBOT1QnLFxuICAgICAgICAkZ3Q6ICc+JyxcbiAgICAgICAgJGx0OiAnPCcsXG4gICAgICAgICRndGU6ICc+PScsXG4gICAgICAgICRsdGU6ICc8PScsXG4gICAgICAgICRpbjogJ0lOJyxcbiAgICAgICAgJGxpa2U6ICdMSUtFJyxcbiAgICAgICAgJHRva2VuOiAndG9rZW4nLFxuICAgICAgICAkY29udGFpbnM6ICdDT05UQUlOUycsXG4gICAgICAgICRjb250YWluc19rZXk6ICdDT05UQUlOUyBLRVknLFxuICAgICAgfTtcblxuICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChmaWVsZFJlbGF0aW9uKSkge1xuICAgICAgICBjb25zdCB2YWxpZEtleXMgPSBPYmplY3Qua2V5cyhjcWxPcGVyYXRvcnMpO1xuICAgICAgICBjb25zdCBmaWVsZFJlbGF0aW9uS2V5cyA9IE9iamVjdC5rZXlzKGZpZWxkUmVsYXRpb24pO1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGZpZWxkUmVsYXRpb25LZXlzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgaWYgKCF2YWxpZEtleXMuaW5jbHVkZXMoZmllbGRSZWxhdGlvbktleXNbaV0pKSB7XG4gICAgICAgICAgICAvLyBmaWVsZCByZWxhdGlvbiBrZXkgaW52YWxpZCwgYXBwbHkgZGVmYXVsdCAkZXEgb3BlcmF0b3JcbiAgICAgICAgICAgIGZpZWxkUmVsYXRpb24gPSB7ICRlcTogZmllbGRSZWxhdGlvbiB9O1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBmaWVsZFJlbGF0aW9uID0geyAkZXE6IGZpZWxkUmVsYXRpb24gfTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVsYXRpb25LZXlzID0gT2JqZWN0LmtleXMoZmllbGRSZWxhdGlvbik7XG4gICAgICBmb3IgKGxldCByayA9IDA7IHJrIDwgcmVsYXRpb25LZXlzLmxlbmd0aDsgcmsrKykge1xuICAgICAgICBjb25zdCByZWxhdGlvbktleSA9IHJlbGF0aW9uS2V5c1tya107XG4gICAgICAgIGNvbnN0IHJlbGF0aW9uVmFsdWUgPSBmaWVsZFJlbGF0aW9uW3JlbGF0aW9uS2V5XTtcbiAgICAgICAgY29uc3QgZXh0cmFjdGVkUmVsYXRpb25zID0gcGFyc2VyLmV4dHJhY3RfcXVlcnlfcmVsYXRpb25zKFxuICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICByZWxhdGlvbktleSxcbiAgICAgICAgICByZWxhdGlvblZhbHVlLFxuICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICBjcWxPcGVyYXRvcnMsXG4gICAgICAgICk7XG4gICAgICAgIHF1ZXJ5UmVsYXRpb25zID0gcXVlcnlSZWxhdGlvbnMuY29uY2F0KGV4dHJhY3RlZFJlbGF0aW9ucy5xdWVyeVJlbGF0aW9ucyk7XG4gICAgICAgIHF1ZXJ5UGFyYW1zID0gcXVlcnlQYXJhbXMuY29uY2F0KGV4dHJhY3RlZFJlbGF0aW9ucy5xdWVyeVBhcmFtcyk7XG4gICAgICB9XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4geyBxdWVyeVJlbGF0aW9ucywgcXVlcnlQYXJhbXMgfTtcbn07XG5cbnBhcnNlci5nZXRfZmlsdGVyX2NsYXVzZSA9IGZ1bmN0aW9uIGYoc2NoZW1hLCBxdWVyeU9iamVjdCwgY2xhdXNlKSB7XG4gIGNvbnN0IHBhcnNlZE9iamVjdCA9IHBhcnNlci5fcGFyc2VfcXVlcnlfb2JqZWN0KHNjaGVtYSwgcXVlcnlPYmplY3QpO1xuICBjb25zdCBmaWx0ZXJDbGF1c2UgPSB7fTtcbiAgaWYgKHBhcnNlZE9iamVjdC5xdWVyeVJlbGF0aW9ucy5sZW5ndGggPiAwKSB7XG4gICAgZmlsdGVyQ2xhdXNlLnF1ZXJ5ID0gdXRpbC5mb3JtYXQoJyVzICVzJywgY2xhdXNlLCBwYXJzZWRPYmplY3QucXVlcnlSZWxhdGlvbnMuam9pbignIEFORCAnKSk7XG4gIH0gZWxzZSB7XG4gICAgZmlsdGVyQ2xhdXNlLnF1ZXJ5ID0gJyc7XG4gIH1cbiAgZmlsdGVyQ2xhdXNlLnBhcmFtcyA9IHBhcnNlZE9iamVjdC5xdWVyeVBhcmFtcztcbiAgcmV0dXJuIGZpbHRlckNsYXVzZTtcbn07XG5cbnBhcnNlci5nZXRfZmlsdGVyX2NsYXVzZV9kZGwgPSBmdW5jdGlvbiBmKHNjaGVtYSwgcXVlcnlPYmplY3QsIGNsYXVzZSkge1xuICBjb25zdCBmaWx0ZXJDbGF1c2UgPSBwYXJzZXIuZ2V0X2ZpbHRlcl9jbGF1c2Uoc2NoZW1hLCBxdWVyeU9iamVjdCwgY2xhdXNlKTtcbiAgbGV0IGZpbHRlclF1ZXJ5ID0gZmlsdGVyQ2xhdXNlLnF1ZXJ5O1xuICBmaWx0ZXJDbGF1c2UucGFyYW1zLmZvckVhY2goKHBhcmFtKSA9PiB7XG4gICAgbGV0IHF1ZXJ5UGFyYW07XG4gICAgaWYgKHR5cGVvZiBwYXJhbSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHF1ZXJ5UGFyYW0gPSB1dGlsLmZvcm1hdChcIiclcydcIiwgcGFyYW0pO1xuICAgIH0gZWxzZSBpZiAocGFyYW0gaW5zdGFuY2VvZiBEYXRlKSB7XG4gICAgICBxdWVyeVBhcmFtID0gdXRpbC5mb3JtYXQoXCInJXMnXCIsIHBhcmFtLnRvSVNPU3RyaW5nKCkpO1xuICAgIH0gZWxzZSBpZiAocGFyYW0gaW5zdGFuY2VvZiBjcWwudHlwZXMuTG9uZ1xuICAgICAgfHwgcGFyYW0gaW5zdGFuY2VvZiBjcWwudHlwZXMuSW50ZWdlclxuICAgICAgfHwgcGFyYW0gaW5zdGFuY2VvZiBjcWwudHlwZXMuQmlnRGVjaW1hbFxuICAgICAgfHwgcGFyYW0gaW5zdGFuY2VvZiBjcWwudHlwZXMuVGltZVV1aWRcbiAgICAgIHx8IHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLlV1aWQpIHtcbiAgICAgIHF1ZXJ5UGFyYW0gPSBwYXJhbS50b1N0cmluZygpO1xuICAgIH0gZWxzZSBpZiAocGFyYW0gaW5zdGFuY2VvZiBjcWwudHlwZXMuTG9jYWxEYXRlXG4gICAgICB8fCBwYXJhbSBpbnN0YW5jZW9mIGNxbC50eXBlcy5Mb2NhbFRpbWVcbiAgICAgIHx8IHBhcmFtIGluc3RhbmNlb2YgY3FsLnR5cGVzLkluZXRBZGRyZXNzKSB7XG4gICAgICBxdWVyeVBhcmFtID0gdXRpbC5mb3JtYXQoXCInJXMnXCIsIHBhcmFtLnRvU3RyaW5nKCkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBxdWVyeVBhcmFtID0gcGFyYW07XG4gICAgfVxuICAgIC8vIFRPRE86IHVuaGFuZGxlZCBpZiBxdWVyeVBhcmFtIGlzIGEgc3RyaW5nIGNvbnRhaW5pbmcgPyBjaGFyYWN0ZXJcbiAgICAvLyB0aG91Z2ggdGhpcyBpcyB1bmxpa2VseSB0byBoYXZlIGluIG1hdGVyaWFsaXplZCB2aWV3IGZpbHRlcnMsIGJ1dC4uLlxuICAgIGZpbHRlclF1ZXJ5ID0gZmlsdGVyUXVlcnkucmVwbGFjZSgnPycsIHF1ZXJ5UGFyYW0pO1xuICB9KTtcbiAgcmV0dXJuIGZpbHRlclF1ZXJ5O1xufTtcblxucGFyc2VyLmdldF93aGVyZV9jbGF1c2UgPSBmdW5jdGlvbiBmKHNjaGVtYSwgcXVlcnlPYmplY3QpIHtcbiAgcmV0dXJuIHBhcnNlci5nZXRfZmlsdGVyX2NsYXVzZShzY2hlbWEsIHF1ZXJ5T2JqZWN0LCAnV0hFUkUnKTtcbn07XG5cbnBhcnNlci5nZXRfaWZfY2xhdXNlID0gZnVuY3Rpb24gZihzY2hlbWEsIHF1ZXJ5T2JqZWN0KSB7XG4gIHJldHVybiBwYXJzZXIuZ2V0X2ZpbHRlcl9jbGF1c2Uoc2NoZW1hLCBxdWVyeU9iamVjdCwgJ0lGJyk7XG59O1xuXG5wYXJzZXIuZ2V0X3ByaW1hcnlfa2V5X2NsYXVzZXMgPSBmdW5jdGlvbiBmKHNjaGVtYSkge1xuICBjb25zdCBwYXJ0aXRpb25LZXkgPSBzY2hlbWEua2V5WzBdO1xuICBsZXQgY2x1c3RlcmluZ0tleSA9IHNjaGVtYS5rZXkuc2xpY2UoMSwgc2NoZW1hLmtleS5sZW5ndGgpO1xuICBjb25zdCBjbHVzdGVyaW5nT3JkZXIgPSBbXTtcblxuICBmb3IgKGxldCBmaWVsZCA9IDA7IGZpZWxkIDwgY2x1c3RlcmluZ0tleS5sZW5ndGg7IGZpZWxkKyspIHtcbiAgICBpZiAoc2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJcbiAgICAgICAgJiYgc2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbY2x1c3RlcmluZ0tleVtmaWVsZF1dXG4gICAgICAgICYmIHNjaGVtYS5jbHVzdGVyaW5nX29yZGVyW2NsdXN0ZXJpbmdLZXlbZmllbGRdXS50b0xvd2VyQ2FzZSgpID09PSAnZGVzYycpIHtcbiAgICAgIGNsdXN0ZXJpbmdPcmRlci5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCIgREVTQycsIGNsdXN0ZXJpbmdLZXlbZmllbGRdKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNsdXN0ZXJpbmdPcmRlci5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCIgQVNDJywgY2x1c3RlcmluZ0tleVtmaWVsZF0pKTtcbiAgICB9XG4gIH1cblxuICBsZXQgY2x1c3RlcmluZ09yZGVyQ2xhdXNlID0gJyc7XG4gIGlmIChjbHVzdGVyaW5nT3JkZXIubGVuZ3RoID4gMCkge1xuICAgIGNsdXN0ZXJpbmdPcmRlckNsYXVzZSA9IHV0aWwuZm9ybWF0KCcgV0lUSCBDTFVTVEVSSU5HIE9SREVSIEJZICglcyknLCBjbHVzdGVyaW5nT3JkZXIudG9TdHJpbmcoKSk7XG4gIH1cblxuICBsZXQgcGFydGl0aW9uS2V5Q2xhdXNlID0gJyc7XG4gIGlmIChfLmlzQXJyYXkocGFydGl0aW9uS2V5KSkge1xuICAgIHBhcnRpdGlvbktleUNsYXVzZSA9IHBhcnRpdGlvbktleS5tYXAoKHYpID0+IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCInLCB2KSkuam9pbignLCcpO1xuICB9IGVsc2Uge1xuICAgIHBhcnRpdGlvbktleUNsYXVzZSA9IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCInLCBwYXJ0aXRpb25LZXkpO1xuICB9XG5cbiAgbGV0IGNsdXN0ZXJpbmdLZXlDbGF1c2UgPSAnJztcbiAgaWYgKGNsdXN0ZXJpbmdLZXkubGVuZ3RoKSB7XG4gICAgY2x1c3RlcmluZ0tleSA9IGNsdXN0ZXJpbmdLZXkubWFwKCh2KSA9PiBwYXJzZXIuZm9ybWF0SlNPTkJDb2x1bW5Bd2FyZSgnXCIlc1wiJywgdikpLmpvaW4oJywnKTtcbiAgICBjbHVzdGVyaW5nS2V5Q2xhdXNlID0gdXRpbC5mb3JtYXQoJywlcycsIGNsdXN0ZXJpbmdLZXkpO1xuICB9XG5cbiAgcmV0dXJuIHsgcGFydGl0aW9uS2V5Q2xhdXNlLCBjbHVzdGVyaW5nS2V5Q2xhdXNlLCBjbHVzdGVyaW5nT3JkZXJDbGF1c2UgfTtcbn07XG5cbnBhcnNlci5nZXRfbXZpZXdfd2hlcmVfY2xhdXNlID0gZnVuY3Rpb24gZihzY2hlbWEsIHZpZXdTY2hlbWEpIHtcbiAgY29uc3QgY2xhdXNlcyA9IHBhcnNlci5nZXRfcHJpbWFyeV9rZXlfY2xhdXNlcyh2aWV3U2NoZW1hKTtcbiAgbGV0IHdoZXJlQ2xhdXNlID0gY2xhdXNlcy5wYXJ0aXRpb25LZXlDbGF1c2Uuc3BsaXQoJywnKS5qb2luKCcgSVMgTk9UIE5VTEwgQU5EICcpO1xuICBpZiAoY2xhdXNlcy5jbHVzdGVyaW5nS2V5Q2xhdXNlKSB3aGVyZUNsYXVzZSArPSBjbGF1c2VzLmNsdXN0ZXJpbmdLZXlDbGF1c2Uuc3BsaXQoJywnKS5qb2luKCcgSVMgTk9UIE5VTEwgQU5EICcpO1xuICB3aGVyZUNsYXVzZSArPSAnIElTIE5PVCBOVUxMJztcblxuICBjb25zdCBmaWx0ZXJzID0gXy5jbG9uZURlZXAodmlld1NjaGVtYS5maWx0ZXJzKTtcblxuICBpZiAoXy5pc1BsYWluT2JqZWN0KGZpbHRlcnMpKSB7XG4gICAgLy8gZGVsZXRlIHByaW1hcnkga2V5IGZpZWxkcyBkZWZpbmVkIGFzIGlzbid0IG51bGwgaW4gZmlsdGVyc1xuICAgIE9iamVjdC5rZXlzKGZpbHRlcnMpLmZvckVhY2goKGZpbHRlcktleSkgPT4ge1xuICAgICAgaWYgKGZpbHRlcnNbZmlsdGVyS2V5XS4kaXNudCA9PT0gbnVsbFxuICAgICAgICAgICYmICh2aWV3U2NoZW1hLmtleS5pbmNsdWRlcyhmaWx0ZXJLZXkpIHx8IHZpZXdTY2hlbWEua2V5WzBdLmluY2x1ZGVzKGZpbHRlcktleSkpKSB7XG4gICAgICAgIGRlbGV0ZSBmaWx0ZXJzW2ZpbHRlcktleV0uJGlzbnQ7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBjb25zdCBmaWx0ZXJDbGF1c2UgPSBwYXJzZXIuZ2V0X2ZpbHRlcl9jbGF1c2VfZGRsKHNjaGVtYSwgZmlsdGVycywgJ0FORCcpO1xuICAgIHdoZXJlQ2xhdXNlICs9IHV0aWwuZm9ybWF0KCcgJXMnLCBmaWx0ZXJDbGF1c2UpLnJlcGxhY2UoL0lTIE5PVCBudWxsL2csICdJUyBOT1QgTlVMTCcpO1xuICB9XG5cbiAgLy8gcmVtb3ZlIHVubmVjZXNzYXJpbHkgcXVvdGVkIGZpZWxkIG5hbWVzIGluIGdlbmVyYXRlZCB3aGVyZSBjbGF1c2VcbiAgLy8gc28gdGhhdCBpdCBtYXRjaGVzIHRoZSB3aGVyZV9jbGF1c2UgZnJvbSBkYXRhYmFzZSBzY2hlbWFcbiAgY29uc3QgcXVvdGVkRmllbGROYW1lcyA9IHdoZXJlQ2xhdXNlLm1hdGNoKC9cIiguKj8pXCIvZyk7XG4gIHF1b3RlZEZpZWxkTmFtZXMuZm9yRWFjaCgoZmllbGROYW1lKSA9PiB7XG4gICAgY29uc3QgdW5xdW90ZWRGaWVsZE5hbWUgPSBmaWVsZE5hbWUucmVwbGFjZSgvXCIvZywgJycpO1xuICAgIGNvbnN0IHJlc2VydmVkS2V5d29yZHMgPSBbXG4gICAgICAnQUREJywgJ0FHR1JFR0FURScsICdBTExPVycsICdBTFRFUicsICdBTkQnLCAnQU5ZJywgJ0FQUExZJyxcbiAgICAgICdBU0MnLCAnQVVUSE9SSVpFJywgJ0JBVENIJywgJ0JFR0lOJywgJ0JZJywgJ0NPTFVNTkZBTUlMWScsXG4gICAgICAnQ1JFQVRFJywgJ0RFTEVURScsICdERVNDJywgJ0RST1AnLCAnRUFDSF9RVU9SVU0nLCAnRU5UUklFUycsXG4gICAgICAnRlJPTScsICdGVUxMJywgJ0dSQU5UJywgJ0lGJywgJ0lOJywgJ0lOREVYJywgJ0lORVQnLCAnSU5GSU5JVFknLFxuICAgICAgJ0lOU0VSVCcsICdJTlRPJywgJ0tFWVNQQUNFJywgJ0tFWVNQQUNFUycsICdMSU1JVCcsICdMT0NBTF9PTkUnLFxuICAgICAgJ0xPQ0FMX1FVT1JVTScsICdNQVRFUklBTElaRUQnLCAnTU9ESUZZJywgJ05BTicsICdOT1JFQ1VSU0lWRScsXG4gICAgICAnTk9UJywgJ09GJywgJ09OJywgJ09ORScsICdPUkRFUicsICdQQVJUSVRJT04nLCAnUEFTU1dPUkQnLCAnUEVSJyxcbiAgICAgICdQUklNQVJZJywgJ1FVT1JVTScsICdSRU5BTUUnLCAnUkVWT0tFJywgJ1NDSEVNQScsICdTRUxFQ1QnLCAnU0VUJyxcbiAgICAgICdUQUJMRScsICdUSU1FJywgJ1RIUkVFJywgJ1RPJywgJ1RPS0VOJywgJ1RSVU5DQVRFJywgJ1RXTycsICdVTkxPR0dFRCcsXG4gICAgICAnVVBEQVRFJywgJ1VTRScsICdVU0lORycsICdWSUVXJywgJ1dIRVJFJywgJ1dJVEgnXTtcbiAgICBpZiAodW5xdW90ZWRGaWVsZE5hbWUgPT09IHVucXVvdGVkRmllbGROYW1lLnRvTG93ZXJDYXNlKClcbiAgICAgICYmICFyZXNlcnZlZEtleXdvcmRzLmluY2x1ZGVzKHVucXVvdGVkRmllbGROYW1lLnRvVXBwZXJDYXNlKCkpKSB7XG4gICAgICB3aGVyZUNsYXVzZSA9IHdoZXJlQ2xhdXNlLnJlcGxhY2UoZmllbGROYW1lLCB1bnF1b3RlZEZpZWxkTmFtZSk7XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIHdoZXJlQ2xhdXNlO1xufTtcblxucGFyc2VyLmdldF9vcmRlcmJ5X2NsYXVzZSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QpIHtcbiAgY29uc3Qgb3JkZXJLZXlzID0gW107XG4gIE9iamVjdC5rZXlzKHF1ZXJ5T2JqZWN0KS5mb3JFYWNoKChrKSA9PiB7XG4gICAgY29uc3QgcXVlcnlJdGVtID0gcXVlcnlPYmplY3Rba107XG4gICAgaWYgKGsudG9Mb3dlckNhc2UoKSA9PT0gJyRvcmRlcmJ5Jykge1xuICAgICAgaWYgKCEocXVlcnlJdGVtIGluc3RhbmNlb2YgT2JqZWN0KSkge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkb3JkZXInKSk7XG4gICAgICB9XG4gICAgICBjb25zdCBvcmRlckl0ZW1LZXlzID0gT2JqZWN0LmtleXMocXVlcnlJdGVtKTtcblxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvcmRlckl0ZW1LZXlzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IGNxbE9yZGVyRGlyZWN0aW9uID0geyAkYXNjOiAnQVNDJywgJGRlc2M6ICdERVNDJyB9O1xuICAgICAgICBpZiAob3JkZXJJdGVtS2V5c1tpXS50b0xvd2VyQ2FzZSgpIGluIGNxbE9yZGVyRGlyZWN0aW9uKSB7XG4gICAgICAgICAgbGV0IG9yZGVyRmllbGRzID0gcXVlcnlJdGVtW29yZGVySXRlbUtleXNbaV1dO1xuXG4gICAgICAgICAgaWYgKCFfLmlzQXJyYXkob3JkZXJGaWVsZHMpKSB7XG4gICAgICAgICAgICBvcmRlckZpZWxkcyA9IFtvcmRlckZpZWxkc107XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgZm9yIChsZXQgaiA9IDA7IGogPCBvcmRlckZpZWxkcy5sZW5ndGg7IGorKykge1xuICAgICAgICAgICAgb3JkZXJLZXlzLnB1c2gocGFyc2VyLmZvcm1hdEpTT05CQ29sdW1uQXdhcmUoXG4gICAgICAgICAgICAgICdcIiVzXCIgJXMnLFxuICAgICAgICAgICAgICBvcmRlckZpZWxkc1tqXSwgY3FsT3JkZXJEaXJlY3Rpb25bb3JkZXJJdGVtS2V5c1tpXV0sXG4gICAgICAgICAgICApKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZG9yZGVydHlwZScsIG9yZGVySXRlbUtleXNbaV0pKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSk7XG4gIHJldHVybiBvcmRlcktleXMubGVuZ3RoID8gdXRpbC5mb3JtYXQoJ09SREVSIEJZICVzJywgb3JkZXJLZXlzLmpvaW4oJywgJykpIDogJyAnO1xufTtcblxucGFyc2VyLmdldF9ncm91cGJ5X2NsYXVzZSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QpIHtcbiAgbGV0IGdyb3VwYnlLZXlzID0gW107XG5cbiAgT2JqZWN0LmtleXMocXVlcnlPYmplY3QpLmZvckVhY2goKGspID0+IHtcbiAgICBjb25zdCBxdWVyeUl0ZW0gPSBxdWVyeU9iamVjdFtrXTtcblxuICAgIGlmIChrLnRvTG93ZXJDYXNlKCkgPT09ICckZ3JvdXBieScpIHtcbiAgICAgIGlmICghKHF1ZXJ5SXRlbSBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkZ3JvdXAnKSk7XG4gICAgICB9XG5cbiAgICAgIGdyb3VwYnlLZXlzID0gZ3JvdXBieUtleXMuY29uY2F0KHF1ZXJ5SXRlbSk7XG4gICAgfVxuICB9KTtcblxuICBncm91cGJ5S2V5cyA9IGdyb3VwYnlLZXlzLm1hcCgoa2V5KSA9PiBgXCIke2tleX1cImApO1xuXG4gIHJldHVybiBncm91cGJ5S2V5cy5sZW5ndGggPyB1dGlsLmZvcm1hdCgnR1JPVVAgQlkgJXMnLCBncm91cGJ5S2V5cy5qb2luKCcsICcpKSA6ICcgJztcbn07XG5cbnBhcnNlci5nZXRfbGltaXRfY2xhdXNlID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCkge1xuICBsZXQgbGltaXQgPSBudWxsO1xuICBPYmplY3Qua2V5cyhxdWVyeU9iamVjdCkuZm9yRWFjaCgoaykgPT4ge1xuICAgIGNvbnN0IHF1ZXJ5SXRlbSA9IHF1ZXJ5T2JqZWN0W2tdO1xuICAgIGlmIChrLnRvTG93ZXJDYXNlKCkgPT09ICckbGltaXQnKSB7XG4gICAgICBpZiAodHlwZW9mIHF1ZXJ5SXRlbSAhPT0gJ251bWJlcicpIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmxpbWl0dHlwZScpKTtcbiAgICAgIGxpbWl0ID0gcXVlcnlJdGVtO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBsaW1pdCA/IHV0aWwuZm9ybWF0KCdMSU1JVCAlcycsIGxpbWl0KSA6ICcgJztcbn07XG5cbnBhcnNlci5nZXRfc2VsZWN0X2NsYXVzZSA9IGZ1bmN0aW9uIGYob3B0aW9ucykge1xuICBsZXQgc2VsZWN0Q2xhdXNlID0gJyonO1xuICBpZiAob3B0aW9ucy5zZWxlY3QgJiYgXy5pc0FycmF5KG9wdGlvbnMuc2VsZWN0KSAmJiBvcHRpb25zLnNlbGVjdC5sZW5ndGggPiAwKSB7XG4gICAgY29uc3Qgc2VsZWN0QXJyYXkgPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG9wdGlvbnMuc2VsZWN0Lmxlbmd0aDsgaSsrKSB7XG4gICAgICAvLyBzZXBhcmF0ZSB0aGUgYWdncmVnYXRlIGZ1bmN0aW9uIGFuZCB0aGUgY29sdW1uIG5hbWUgaWYgc2VsZWN0IGlzIGFuIGFnZ3JlZ2F0ZSBmdW5jdGlvblxuICAgICAgY29uc3Qgc2VsZWN0aW9uID0gb3B0aW9ucy5zZWxlY3RbaV0uc3BsaXQoL1soLCApXS9nKS5maWx0ZXIoKGUpID0+IChlKSk7XG4gICAgICBpZiAoc2VsZWN0aW9uLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICBpZiAoc2VsZWN0aW9uWzBdID09PSAnKicpIHNlbGVjdEFycmF5LnB1c2goJyonKTtcbiAgICAgICAgZWxzZSBzZWxlY3RBcnJheS5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCInLCBzZWxlY3Rpb25bMF0pKTtcbiAgICAgIH0gZWxzZSBpZiAoc2VsZWN0aW9uLmxlbmd0aCA9PT0gMikge1xuICAgICAgICBzZWxlY3RBcnJheS5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCclcyhcIiVzXCIpJywgc2VsZWN0aW9uWzBdLCBzZWxlY3Rpb25bMV0pKTtcbiAgICAgIH0gZWxzZSBpZiAoc2VsZWN0aW9uLmxlbmd0aCA+PSAzICYmIHNlbGVjdGlvbltzZWxlY3Rpb24ubGVuZ3RoIC0gMl0udG9Mb3dlckNhc2UoKSA9PT0gJ2FzJykge1xuICAgICAgICBjb25zdCBzZWxlY3Rpb25FbmRDaHVuayA9IHNlbGVjdGlvbi5zcGxpY2Uoc2VsZWN0aW9uLmxlbmd0aCAtIDIpO1xuICAgICAgICBsZXQgc2VsZWN0aW9uQ2h1bmsgPSAnJztcbiAgICAgICAgaWYgKHNlbGVjdGlvbi5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgICBzZWxlY3Rpb25DaHVuayA9IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCdcIiVzXCInLCBzZWxlY3Rpb25bMF0pO1xuICAgICAgICB9IGVsc2UgaWYgKHNlbGVjdGlvbi5sZW5ndGggPT09IDIpIHtcbiAgICAgICAgICBzZWxlY3Rpb25DaHVuayA9IHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCclcyhcIiVzXCIpJywgc2VsZWN0aW9uWzBdLCBzZWxlY3Rpb25bMV0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHNlbGVjdGlvbkNodW5rID0gdXRpbC5mb3JtYXQoJyVzKCVzKScsIHNlbGVjdGlvblswXSwgYFwiJHtzZWxlY3Rpb24uc3BsaWNlKDEpLmpvaW4oJ1wiLFwiJyl9XCJgKTtcbiAgICAgICAgfVxuICAgICAgICBzZWxlY3RBcnJheS5wdXNoKHBhcnNlci5mb3JtYXRKU09OQkNvbHVtbkF3YXJlKCclcyBBUyBcIiVzXCInLCBzZWxlY3Rpb25DaHVuaywgc2VsZWN0aW9uRW5kQ2h1bmtbMV0pKTtcbiAgICAgIH0gZWxzZSBpZiAoc2VsZWN0aW9uLmxlbmd0aCA+PSAzKSB7XG4gICAgICAgIHNlbGVjdEFycmF5LnB1c2godXRpbC5mb3JtYXQoJyVzKCVzKScsIHNlbGVjdGlvblswXSwgYFwiJHtzZWxlY3Rpb24uc3BsaWNlKDEpLmpvaW4oJ1wiLFwiJyl9XCJgKSk7XG4gICAgICB9XG4gICAgfVxuICAgIHNlbGVjdENsYXVzZSA9IHNlbGVjdEFycmF5LmpvaW4oJywnKTtcbiAgfVxuICByZXR1cm4gc2VsZWN0Q2xhdXNlO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBwYXJzZXI7XG4iXX0=