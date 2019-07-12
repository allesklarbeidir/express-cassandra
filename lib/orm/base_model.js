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

var buildError = require('./apollo_error.js');
var schemer = require('../validators/schema');
var normalizer = require('../utils/normalizer');
var parser = require('../utils/parser');

var TableBuilder = require('../builders/table');
var ElassandraBuilder = require('../builders/elassandra');
var JanusGraphBuilder = require('../builders/janusgraph');
var Driver = require('../helpers/driver');

var BaseModel = function f(instanceValues) {
  instanceValues = instanceValues || {};
  var fieldValues = {};
  var fields = this.constructor._properties.schema.fields;
  var methods = this.constructor._properties.schema.methods || {};
  var model = this;

  var defaultSetter = function f1(propName, newValue) {
    if (this[propName] !== newValue) {
      model._modified[propName] = true;
    }
    this[propName] = newValue;
  };

  var defaultGetter = function f1(propName) {
    return this[propName];
  };

  this._modified = {};
  this._validators = {};

  for (var fieldsKeys = Object.keys(fields), i = 0, len = fieldsKeys.length; i < len; i++) {
    var propertyName = fieldsKeys[i];
    var field = fields[fieldsKeys[i]];

    try {
      this._validators[propertyName] = schemer.get_validators(this.constructor._properties.schema, propertyName);
    } catch (e) {
      throw buildError('model.validator.invalidschema', e.message);
    }

    var setter = defaultSetter.bind(fieldValues, propertyName);
    var getter = defaultGetter.bind(fieldValues, propertyName);

    if (field.virtual && typeof field.virtual.set === 'function') {
      setter = field.virtual.set.bind(fieldValues);
    }

    if (field.virtual && typeof field.virtual.get === 'function') {
      getter = field.virtual.get.bind(fieldValues);
    }

    var descriptor = {
      enumerable: true,
      set: setter,
      get: getter
    };

    Object.defineProperty(this, propertyName, descriptor);
    if (field.virtual && typeof instanceValues[propertyName] !== 'undefined') {
      this[propertyName] = instanceValues[propertyName];
    }
  }

  for (var _fieldsKeys = Object.keys(fields), _i = 0, _len = _fieldsKeys.length; _i < _len; _i++) {
    var _propertyName = _fieldsKeys[_i];
    var _field = fields[_fieldsKeys[_i]];

    if (!_field.virtual && typeof instanceValues[_propertyName] !== 'undefined') {
      this[_propertyName] = instanceValues[_propertyName];
    }
  }

  for (var methodNames = Object.keys(methods), _i2 = 0, _len2 = methodNames.length; _i2 < _len2; _i2++) {
    var methodName = methodNames[_i2];
    var method = methods[methodName];
    this[methodName] = method;
  }
};

BaseModel._properties = {
  name: null,
  schema: null
};

BaseModel._set_properties = function f(properties) {
  var schema = properties.schema;
  var tableName = schema.table_name || properties.name;

  if (!schemer.validate_table_name(tableName)) {
    throw buildError('model.tablecreation.invalidname', tableName);
  }

  var qualifiedTableName = util.format('"%s"."%s"', properties.keyspace, tableName);

  this._properties = properties;
  this._properties.table_name = tableName;
  this._properties.qualified_table_name = qualifiedTableName;
  this._driver = new Driver(this._properties);
};

BaseModel._sync_model_definition = function f(callback) {
  var properties = this._properties;
  var tableName = properties.table_name;
  var modelSchema = properties.schema;
  var migration = properties.migration;

  var tableBuilder = new TableBuilder(this._driver, this._properties);

  // backwards compatible change, dropTableOnSchemaChange will work like migration: 'drop'
  if (!migration) {
    if (properties.dropTableOnSchemaChange) migration = 'drop';else migration = 'safe';
  }
  // always safe migrate if NODE_ENV==='production'
  if (process.env.NODE_ENV === 'production') migration = 'safe';

  // check for existence of table on DB and if it matches this model's schema
  tableBuilder.get_table_schema(function (err, dbSchema) {
    if (err) {
      callback(err);
      return;
    }

    var afterDBCreate = function afterDBCreate(err1) {
      if (err1) {
        callback(err1);
        return;
      }

      var indexingTasks = [];

      // cassandra index create if defined
      if (_.isArray(modelSchema.indexes)) {
        tableBuilder.createIndexesAsync = Promise.promisify(tableBuilder.create_indexes);
        indexingTasks.push(tableBuilder.createIndexesAsync(modelSchema.indexes));
      }
      // cassandra custom index create if defined
      if (_.isArray(modelSchema.custom_indexes)) {
        tableBuilder.createCustomIndexesAsync = Promise.promisify(tableBuilder.create_custom_indexes);
        indexingTasks.push(tableBuilder.createCustomIndexesAsync(modelSchema.custom_indexes));
      }
      if (modelSchema.custom_index) {
        tableBuilder.createCustomIndexAsync = Promise.promisify(tableBuilder.create_custom_indexes);
        indexingTasks.push(tableBuilder.createCustomIndexAsync([modelSchema.custom_index]));
      }
      // materialized view create if defined
      if (modelSchema.materialized_views) {
        tableBuilder.createViewsAsync = Promise.promisify(tableBuilder.create_mviews);
        indexingTasks.push(tableBuilder.createViewsAsync(modelSchema.materialized_views));
      }

      Promise.all(indexingTasks).then(function () {
        // db schema was updated, so callback with true
        callback(null, true);
      }).catch(function (err2) {
        callback(err2);
      });
    };

    if (!dbSchema) {
      if (properties.createTable === false) {
        callback(buildError('model.tablecreation.schemanotfound', tableName));
        return;
      }
      // if not existing, it's created
      tableBuilder.create_table(modelSchema, afterDBCreate);
      return;
    }

    var normalizedModelSchema = void 0;
    var normalizedDBSchema = void 0;

    try {
      normalizedModelSchema = normalizer.normalize_model_schema(modelSchema);
      normalizedDBSchema = normalizer.normalize_model_schema(dbSchema);
    } catch (e) {
      throw buildError('model.validator.invalidschema', e.message);
    }

    if (_.isEqual(normalizedModelSchema, normalizedDBSchema)) {
      // no change in db was made, so callback with false
      callback(null, false);
      return;
    }

    if (migration === 'alter') {
      // check if table can be altered to match schema
      if (_.isEqual(normalizedModelSchema.key, normalizedDBSchema.key) && _.isEqual(normalizedModelSchema.clustering_order, normalizedDBSchema.clustering_order)) {
        tableBuilder.init_alter_operations(modelSchema, dbSchema, normalizedModelSchema, normalizedDBSchema, function (err1) {
          if (err1 && err1.message === 'alter_impossible') {
            tableBuilder.drop_recreate_table(modelSchema, normalizedDBSchema.materialized_views, afterDBCreate);
            return;
          }
          callback(err1);
        });
      } else {
        tableBuilder.drop_recreate_table(modelSchema, normalizedDBSchema.materialized_views, afterDBCreate);
      }
    } else if (migration === 'drop') {
      tableBuilder.drop_recreate_table(modelSchema, normalizedDBSchema.materialized_views, afterDBCreate);
    } else {
      callback(buildError('model.tablecreation.schemamismatch', tableName, 'migration suspended, please apply the change manually'));
    }
  });
};

BaseModel._sync_es_index = function f(callback) {
  var properties = this._properties;

  if (properties.esclient && properties.schema.es_index_mapping) {
    var keyspaceName = properties.keyspace;
    var mappingName = properties.table_name;
    var indexName = `${keyspaceName}_${mappingName}`;

    var elassandraBuilder = new ElassandraBuilder(properties.esclient);
    elassandraBuilder.assert_index(keyspaceName, indexName, function (err) {
      if (err) {
        callback(err);
        return;
      }
      elassandraBuilder.put_mapping(indexName, mappingName, properties.schema.es_index_mapping, callback);
    });
    return;
  }
  callback();
};

BaseModel._sync_graph = function f(callback) {
  var properties = this._properties;

  if (properties.gremlin_client && properties.schema.graph_mapping) {
    var graphName = `${properties.keyspace}_graph`;
    var mappingName = properties.table_name;

    var graphBuilder = new JanusGraphBuilder(properties.gremlin_client);
    graphBuilder.assert_graph(graphName, function (err) {
      if (err) {
        callback(err);
        return;
      }
      graphBuilder.put_mapping(graphName, mappingName, properties.schema.graph_mapping, callback);
    });
    return;
  }
  callback();
};

BaseModel._execute_table_query = function f(query, params, options, callback) {
  if (arguments.length === 3) {
    callback = options;
    options = {};
  }

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var doExecuteQuery = function f1(doquery, docallback) {
    this.execute_query(doquery, params, options, docallback);
  }.bind(this, query);

  if (this.is_table_ready()) {
    doExecuteQuery(callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      doExecuteQuery(callback);
    });
  }
};

BaseModel.get_find_query = function f(queryObject, options) {
  var orderbyClause = parser.get_orderby_clause(queryObject);
  var limitClause = parser.get_limit_clause(queryObject);
  var whereClause = parser.get_where_clause(this._properties.schema, queryObject);
  var selectClause = parser.get_select_clause(options);
  var groupbyClause = parser.get_groupby_clause(options);

  var query = util.format('SELECT %s %s FROM "%s" %s %s %s %s', options.distinct ? 'DISTINCT' : '', selectClause, options.materialized_view ? options.materialized_view : this._properties.table_name, whereClause.query, orderbyClause, groupbyClause, limitClause);

  if (options.allow_filtering) query += ' ALLOW FILTERING;';else query += ';';

  return { query, params: whereClause.params };
};

BaseModel.get_table_name = function f() {
  return this._properties.table_name;
};

BaseModel.get_keyspace_name = function f() {
  return this._properties.keyspace;
};

BaseModel.is_table_ready = function f() {
  return this._ready === true;
};

BaseModel.init = function f(options, callback) {
  if (!callback) {
    callback = options;
    options = undefined;
  }

  this._ready = true;
  callback();
};

BaseModel.syncDB = function f(callback) {
  var _this = this;

  this._sync_model_definition(function (err, result) {
    if (err) {
      callback(err);
      return;
    }

    _this._sync_es_index(function (err1) {
      if (err1) {
        callback(err1);
        return;
      }

      _this._sync_graph(function (err2) {
        if (err2) {
          callback(err2);
          return;
        }

        _this._ready = true;
        callback(null, result);
      });
    });
  });
};

BaseModel.get_cql_client = function f(callback) {
  var _this2 = this;

  this._driver.ensure_init(function (err) {
    if (err) {
      callback(err);
      return;
    }
    callback(null, _this2._properties.cql);
  });
};

BaseModel.get_es_client = function f() {
  if (!this._properties.esclient) {
    throw new Error('To use elassandra features, set `manageESIndex` to true in ormOptions');
  }
  return this._properties.esclient;
};

BaseModel.get_gremlin_client = function f() {
  if (!this._properties.gremlin_client) {
    throw new Error('To use janus graph features, set `manageGraphs` to true in ormOptions');
  }
  return this._properties.gremlin_client;
};

BaseModel.execute_query = function f() {
  var _driver;

  (_driver = this._driver).execute_query.apply(_driver, arguments);
};

BaseModel.execute_batch = function f() {
  var _driver2;

  (_driver2 = this._driver).execute_batch.apply(_driver2, arguments);
};

BaseModel.execute_eachRow = function f() {
  var _driver3;

  (_driver3 = this._driver).execute_eachRow.apply(_driver3, arguments);
};

BaseModel._execute_table_eachRow = function f(query, params, options, onReadable, callback) {
  var _this3 = this;

  if (this.is_table_ready()) {
    this.execute_eachRow(query, params, options, onReadable, callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      _this3.execute_eachRow(query, params, options, onReadable, callback);
    });
  }
};

BaseModel.eachRow = function f(queryObject, options, onReadable, callback) {
  var _this4 = this;

  if (arguments.length === 3) {
    var cb = onReadable;
    onReadable = options;
    callback = cb;
    options = {};
  }
  if (typeof onReadable !== 'function') {
    throw buildError('model.find.eachrowerror', 'no valid onReadable function was provided');
  }
  if (typeof callback !== 'function') {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  options.return_query = true;
  var selectQuery = this.find(queryObject, options);

  var queryOptions = normalizer.normalize_query_option(options);

  this._execute_table_eachRow(selectQuery.query, selectQuery.params, queryOptions, function (n, row) {
    if (!options.raw) {
      var ModelConstructor = _this4._properties.get_constructor();
      row = new ModelConstructor(row);
      row._modified = {};
    }
    onReadable(n, row);
  }, function (err, result) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    callback(err, result);
  });
};

BaseModel.execute_stream = function f() {
  var _driver4;

  (_driver4 = this._driver).execute_stream.apply(_driver4, arguments);
};

BaseModel._execute_table_stream = function f(query, params, options, onReadable, callback) {
  var _this5 = this;

  if (this.is_table_ready()) {
    this.execute_stream(query, params, options, onReadable, callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      _this5.execute_stream(query, params, options, onReadable, callback);
    });
  }
};

BaseModel.stream = function f(queryObject, options, onReadable, callback) {
  if (arguments.length === 3) {
    var cb = onReadable;
    onReadable = options;
    callback = cb;
    options = {};
  }

  if (typeof onReadable !== 'function') {
    throw buildError('model.find.streamerror', 'no valid onReadable function was provided');
  }
  if (typeof callback !== 'function') {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  options.return_query = true;
  var selectQuery = this.find(queryObject, options);

  var queryOptions = normalizer.normalize_query_option(options);

  var self = this;

  this._execute_table_stream(selectQuery.query, selectQuery.params, queryOptions, function f1() {
    var reader = this;
    reader.readRow = function () {
      var row = reader.read();
      if (!row) return row;
      if (!options.raw) {
        var ModelConstructor = self._properties.get_constructor();
        var o = new ModelConstructor(row);
        o._modified = {};
        return o;
      }
      return row;
    };
    onReadable(reader);
  }, function (err) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    callback();
  });
};

BaseModel._execute_gremlin_query = function f(script, bindings, callback) {
  var gremlinClient = this.get_gremlin_client();
  gremlinClient.execute(script, bindings, function (err, results) {
    if (err) {
      callback(err);
      return;
    }
    callback(null, results);
  });
};

BaseModel._execute_gremlin_script = function f(script, bindings, callback) {
  this._execute_gremlin_query(script, bindings, function (err, results) {
    if (err) {
      callback(err);
      return;
    }
    callback(null, results[0]);
  });
};

BaseModel.createVertex = function f(vertexProperties, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var __vertexLabel = properties.table_name;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    vertex = graph.addVertex(__vertexLabel);
  `;
  Object.keys(vertexProperties).forEach(function (property) {
    script += `vertex.property('${property}', ${property});`;
  });
  script += 'vertex';
  var bindings = _.defaults(vertexProperties, {
    __graphName,
    __vertexLabel
  });
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.getVertex = function f(__vertexId, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    vertex = g.V(__vertexId);
  `;
  var bindings = {
    __graphName,
    __vertexId
  };
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.updateVertex = function f(__vertexId, vertexProperties, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    vertex = g.V(__vertexId);
  `;
  Object.keys(vertexProperties).forEach(function (property) {
    script += `vertex.property('${property}', ${property});`;
  });
  script += 'vertex';
  var bindings = _.defaults(vertexProperties, {
    __graphName,
    __vertexId
  });
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.deleteVertex = function f(__vertexId, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    vertex = g.V(__vertexId);
    vertex.drop();
  `;
  var bindings = {
    __graphName,
    __vertexId
  };
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.createEdge = function f(__edgeLabel, __fromVertexId, __toVertexId, edgeProperties, callback) {
  if (arguments.length === 4 && typeof edgeProperties === 'function') {
    callback = edgeProperties;
    edgeProperties = {};
  }
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    fromVertex = g.V(__fromVertexId).next();
    toVertex = g.V(__toVertexId).next();
    edge = fromVertex.addEdge(__edgeLabel, toVertex);
  `;
  Object.keys(edgeProperties).forEach(function (property) {
    script += `edge.property('${property}', ${property});`;
  });
  script += 'edge';
  var bindings = _.defaults(edgeProperties, {
    __graphName,
    __fromVertexId,
    __toVertexId,
    __edgeLabel
  });
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.getEdge = function f(__edgeId, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    edge = g.E(__edgeId);
  `;
  var bindings = {
    __graphName,
    __edgeId
  };
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.updateEdge = function f(__edgeId, edgeProperties, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    edge = g.E(__edgeId);
  `;
  Object.keys(edgeProperties).forEach(function (property) {
    script += `edge.property('${property}', ${property});`;
  });
  script += 'edge';
  var bindings = _.defaults(edgeProperties, {
    __graphName,
    __edgeId
  });
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.deleteEdge = function f(__edgeId, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    edge = g.E(__edgeId);
    edge.drop();
  `;
  var bindings = {
    __graphName,
    __edgeId
  };
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.graphQuery = function f(query, params, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var __vertexLabel = properties.table_name;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    vertices = g.V().hasLabel(__vertexLabel);
  `;
  script += query;
  var bindings = _.defaults(params, {
    __graphName,
    __vertexLabel
  });
  this._execute_gremlin_query(script, bindings, callback);
};

BaseModel.search = function f(queryObject, callback) {
  var esClient = this.get_es_client();
  var indexName = `${this._properties.keyspace}_${this._properties.table_name}`;

  var query = _.defaults(queryObject, {
    index: indexName,
    type: this._properties.table_name
  });
  esClient.search(query, function (err, response) {
    if (err) {
      callback(err);
      return;
    }
    callback(null, response);
  });
};

BaseModel.find = function f(queryObject, options, callback) {
  var _this6 = this;

  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function' && !options.return_query) {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  // set raw true if select is used,
  // because casting to model instances may lead to problems
  if (options.select) options.raw = true;

  var queryParams = [];

  var query = void 0;
  try {
    var findQuery = this.get_find_query(queryObject, options);
    query = findQuery.query;
    queryParams = queryParams.concat(findQuery.params);
  } catch (e) {
    parser.callback_or_throw(e, callback);
    return {};
  }

  if (options.return_query) {
    return { query, params: queryParams };
  }

  var queryOptions = normalizer.normalize_query_option(options);

  this._execute_table_query(query, queryParams, queryOptions, function (err, results) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    if (!options.raw) {
      var ModelConstructor = _this6._properties.get_constructor();
      results = results.rows.map(function (res) {
        delete res.columns;
        var o = new ModelConstructor(res);
        o._modified = {};
        return o;
      });
      callback(null, results);
    } else {
      results = results.rows.map(function (res) {
        delete res.columns;
        return res;
      });
      callback(null, results);
    }
  });

  return {};
};

BaseModel.findOne = function f(queryObject, options, callback) {
  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function' && !options.return_query) {
    throw buildError('model.find.cberror');
  }

  queryObject.$limit = 1;

  return this.find(queryObject, options, function (err, results) {
    if (err) {
      callback(err);
      return;
    }
    if (results.length > 0) {
      callback(null, results[0]);
      return;
    }
    callback();
  });
};

BaseModel.update = function f(queryObject, updateValues, options, callback) {
  if (arguments.length === 3 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this._properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  if (typeof schema.before_update === 'function' && schema.before_update(queryObject, updateValues, options) === false) {
    parser.callback_or_throw(buildError('model.update.before.error'), callback);
    return {};
  }

  var _parser$get_update_va = parser.get_update_value_expression(this, schema, updateValues, callback),
      updateClauses = _parser$get_update_va.updateClauses,
      queryParams = _parser$get_update_va.queryParams,
      errorHappened = _parser$get_update_va.errorHappened;

  if (errorHappened) return {};

  var query = 'UPDATE "%s"';
  var where = '';
  var finalParams = queryParams;
  if (options.ttl) query += util.format(' USING TTL %s', options.ttl);
  query += ' SET %s %s';
  try {
    var whereClause = parser.get_where_clause(schema, queryObject);
    where = whereClause.query;
    finalParams = finalParams.concat(whereClause.params);
  } catch (e) {
    parser.callback_or_throw(e, callback);
    return {};
  }

  query = util.format(query, this._properties.table_name, updateClauses.join(', '), where);

  if (options.conditions) {
    var ifClause = parser.get_if_clause(schema, options.conditions);
    if (ifClause.query) {
      query += util.format(' %s', ifClause.query);
      finalParams = finalParams.concat(ifClause.params);
    }
  } else if (options.if_exists) {
    query += ' IF EXISTS';
  }

  query += ';';

  if (options.return_query) {
    var returnObj = {
      query,
      params: finalParams,
      after_hook: function after_hook() {
        if (typeof schema.after_update === 'function' && schema.after_update(queryObject, updateValues, options) === false) {
          return buildError('model.update.after.error');
        }
        return true;
      }
    };
    return returnObj;
  }

  var queryOptions = normalizer.normalize_query_option(options);

  this._execute_table_query(query, finalParams, queryOptions, function (err, results) {
    if (typeof callback === 'function') {
      if (err) {
        callback(buildError('model.update.dberror', err));
        return;
      }
      if (typeof schema.after_update === 'function' && schema.after_update(queryObject, updateValues, options) === false) {
        callback(buildError('model.update.after.error'));
        return;
      }
      callback(null, results);
    } else if (err) {
      throw buildError('model.update.dberror', err);
    } else if (typeof schema.after_update === 'function' && schema.after_update(queryObject, updateValues, options) === false) {
      throw buildError('model.update.after.error');
    }
  });

  return {};
};

BaseModel.delete = function f(queryObject, options, callback) {
  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this._properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  if (typeof schema.before_delete === 'function' && schema.before_delete(queryObject, options) === false) {
    parser.callback_or_throw(buildError('model.delete.before.error'), callback);
    return {};
  }

  var queryParams = [];

  var query = 'DELETE FROM "%s" %s;';
  var where = '';
  try {
    var whereClause = parser.get_where_clause(schema, queryObject);
    where = whereClause.query;
    queryParams = queryParams.concat(whereClause.params);
  } catch (e) {
    parser.callback_or_throw(e, callback);
    return {};
  }

  query = util.format(query, this._properties.table_name, where);

  if (options.return_query) {
    var returnObj = {
      query,
      params: queryParams,
      after_hook: function after_hook() {
        if (typeof schema.after_delete === 'function' && schema.after_delete(queryObject, options) === false) {
          return buildError('model.delete.after.error');
        }
        return true;
      }
    };
    return returnObj;
  }

  var queryOptions = normalizer.normalize_query_option(options);

  this._execute_table_query(query, queryParams, queryOptions, function (err, results) {
    if (typeof callback === 'function') {
      if (err) {
        callback(buildError('model.delete.dberror', err));
        return;
      }
      if (typeof schema.after_delete === 'function' && schema.after_delete(queryObject, options) === false) {
        callback(buildError('model.delete.after.error'));
        return;
      }
      callback(null, results);
    } else if (err) {
      throw buildError('model.delete.dberror', err);
    } else if (typeof schema.after_delete === 'function' && schema.after_delete(queryObject, options) === false) {
      throw buildError('model.delete.after.error');
    }
  });

  return {};
};

BaseModel.truncate = function f(callback) {
  var properties = this._properties;
  var tableName = properties.table_name;

  var query = util.format('TRUNCATE TABLE "%s";', tableName);
  this._execute_table_query(query, [], callback);
};

BaseModel.prototype.get_data_types = function f() {
  return cql.types;
};

BaseModel.prototype.get_table_name = function f() {
  return this.constructor.get_table_name();
};

BaseModel.prototype.get_keyspace_name = function f() {
  return this.constructor.get_keyspace_name();
};

BaseModel.prototype._get_default_value = function f(fieldname) {
  var properties = this.constructor._properties;
  var schema = properties.schema;

  if (_.isPlainObject(schema.fields[fieldname]) && schema.fields[fieldname].default !== undefined) {
    if (typeof schema.fields[fieldname].default === 'function') {
      return schema.fields[fieldname].default.call(this);
    }
    return schema.fields[fieldname].default;
  }
  return undefined;
};

BaseModel.prototype.validate = function f(propertyName, value) {
  value = value || this[propertyName];
  this._validators = this._validators || {};
  return schemer.get_validation_message(this._validators[propertyName] || [], value);
};

BaseModel.prototype.save = function fn(options, callback) {
  var _this7 = this;

  if (arguments.length === 1 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var properties = this.constructor._properties;
  var schema = properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  if (typeof schema.before_save === 'function' && schema.before_save(this, options) === false) {
    parser.callback_or_throw(buildError('model.save.before.error'), callback);
    return {};
  }

  var _parser$get_save_valu = parser.get_save_value_expression(this, schema, callback),
      identifiers = _parser$get_save_valu.identifiers,
      values = _parser$get_save_valu.values,
      queryParams = _parser$get_save_valu.queryParams,
      errorHappened = _parser$get_save_valu.errorHappened;

  if (errorHappened) return {};

  var query = util.format('INSERT INTO "%s" ( %s ) VALUES ( %s )', properties.table_name, identifiers.join(' , '), values.join(' , '));

  if (options.if_not_exist) query += ' IF NOT EXISTS';
  if (options.ttl) query += util.format(' USING TTL %s', options.ttl);

  query += ';';

  if (options.return_query) {
    var returnObj = {
      query,
      params: queryParams,
      after_hook: function after_hook() {
        if (typeof schema.after_save === 'function' && schema.after_save(_this7, options) === false) {
          return buildError('model.save.after.error');
        }
        return true;
      }
    };
    return returnObj;
  }

  var queryOptions = normalizer.normalize_query_option(options);

  this.constructor._execute_table_query(query, queryParams, queryOptions, function (err, result) {
    if (typeof callback === 'function') {
      if (err) {
        callback(buildError('model.save.dberror', err));
        return;
      }
      if (!options.if_not_exist || result.rows && result.rows[0] && result.rows[0]['[applied]']) {
        _this7._modified = {};
      }
      if (typeof schema.after_save === 'function' && schema.after_save(_this7, options) === false) {
        callback(buildError('model.save.after.error'));
        return;
      }
      callback(null, result);
    } else if (err) {
      throw buildError('model.save.dberror', err);
    } else if (typeof schema.after_save === 'function' && schema.after_save(_this7, options) === false) {
      throw buildError('model.save.after.error');
    }
  });

  return {};
};

BaseModel.prototype.delete = function f(options, callback) {
  if (arguments.length === 1 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this.constructor._properties.schema;
  var deleteQuery = {};

  for (var i = 0; i < schema.key.length; i++) {
    var fieldKey = schema.key[i];
    if (_.isArray(fieldKey)) {
      for (var j = 0; j < fieldKey.length; j++) {
        deleteQuery[fieldKey[j]] = this[fieldKey[j]];
      }
    } else {
      deleteQuery[fieldKey] = this[fieldKey];
    }
  }

  return this.constructor.delete(deleteQuery, options, callback);
};

BaseModel.prototype.toJSON = function toJSON() {
  var _this8 = this;

  var object = {};
  var schema = this.constructor._properties.schema;

  Object.keys(schema.fields).forEach(function (field) {
    object[field] = _this8[field];
  });

  return object;
};

BaseModel.prototype.isModified = function isModified(propName) {
  if (propName) {
    return Object.prototype.hasOwnProperty.call(this._modified, propName);
  }
  return Object.keys(this._modified).length !== 0;
};

module.exports = BaseModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9vcm0vYmFzZV9tb2RlbC5qcyJdLCJuYW1lcyI6WyJQcm9taXNlIiwicmVxdWlyZSIsIl8iLCJ1dGlsIiwiZHNlRHJpdmVyIiwiZSIsImNxbCIsInByb21pc2lmeUFsbCIsImJ1aWxkRXJyb3IiLCJzY2hlbWVyIiwibm9ybWFsaXplciIsInBhcnNlciIsIlRhYmxlQnVpbGRlciIsIkVsYXNzYW5kcmFCdWlsZGVyIiwiSmFudXNHcmFwaEJ1aWxkZXIiLCJEcml2ZXIiLCJCYXNlTW9kZWwiLCJmIiwiaW5zdGFuY2VWYWx1ZXMiLCJmaWVsZFZhbHVlcyIsImZpZWxkcyIsImNvbnN0cnVjdG9yIiwiX3Byb3BlcnRpZXMiLCJzY2hlbWEiLCJtZXRob2RzIiwibW9kZWwiLCJkZWZhdWx0U2V0dGVyIiwiZjEiLCJwcm9wTmFtZSIsIm5ld1ZhbHVlIiwiX21vZGlmaWVkIiwiZGVmYXVsdEdldHRlciIsIl92YWxpZGF0b3JzIiwiZmllbGRzS2V5cyIsIk9iamVjdCIsImtleXMiLCJpIiwibGVuIiwibGVuZ3RoIiwicHJvcGVydHlOYW1lIiwiZmllbGQiLCJnZXRfdmFsaWRhdG9ycyIsIm1lc3NhZ2UiLCJzZXR0ZXIiLCJiaW5kIiwiZ2V0dGVyIiwidmlydHVhbCIsInNldCIsImdldCIsImRlc2NyaXB0b3IiLCJlbnVtZXJhYmxlIiwiZGVmaW5lUHJvcGVydHkiLCJtZXRob2ROYW1lcyIsIm1ldGhvZE5hbWUiLCJtZXRob2QiLCJuYW1lIiwiX3NldF9wcm9wZXJ0aWVzIiwicHJvcGVydGllcyIsInRhYmxlTmFtZSIsInRhYmxlX25hbWUiLCJ2YWxpZGF0ZV90YWJsZV9uYW1lIiwicXVhbGlmaWVkVGFibGVOYW1lIiwiZm9ybWF0Iiwia2V5c3BhY2UiLCJxdWFsaWZpZWRfdGFibGVfbmFtZSIsIl9kcml2ZXIiLCJfc3luY19tb2RlbF9kZWZpbml0aW9uIiwiY2FsbGJhY2siLCJtb2RlbFNjaGVtYSIsIm1pZ3JhdGlvbiIsInRhYmxlQnVpbGRlciIsImRyb3BUYWJsZU9uU2NoZW1hQ2hhbmdlIiwicHJvY2VzcyIsImVudiIsIk5PREVfRU5WIiwiZ2V0X3RhYmxlX3NjaGVtYSIsImVyciIsImRiU2NoZW1hIiwiYWZ0ZXJEQkNyZWF0ZSIsImVycjEiLCJpbmRleGluZ1Rhc2tzIiwiaXNBcnJheSIsImluZGV4ZXMiLCJjcmVhdGVJbmRleGVzQXN5bmMiLCJwcm9taXNpZnkiLCJjcmVhdGVfaW5kZXhlcyIsInB1c2giLCJjdXN0b21faW5kZXhlcyIsImNyZWF0ZUN1c3RvbUluZGV4ZXNBc3luYyIsImNyZWF0ZV9jdXN0b21faW5kZXhlcyIsImN1c3RvbV9pbmRleCIsImNyZWF0ZUN1c3RvbUluZGV4QXN5bmMiLCJtYXRlcmlhbGl6ZWRfdmlld3MiLCJjcmVhdGVWaWV3c0FzeW5jIiwiY3JlYXRlX212aWV3cyIsImFsbCIsInRoZW4iLCJjYXRjaCIsImVycjIiLCJjcmVhdGVUYWJsZSIsImNyZWF0ZV90YWJsZSIsIm5vcm1hbGl6ZWRNb2RlbFNjaGVtYSIsIm5vcm1hbGl6ZWREQlNjaGVtYSIsIm5vcm1hbGl6ZV9tb2RlbF9zY2hlbWEiLCJpc0VxdWFsIiwia2V5IiwiY2x1c3RlcmluZ19vcmRlciIsImluaXRfYWx0ZXJfb3BlcmF0aW9ucyIsImRyb3BfcmVjcmVhdGVfdGFibGUiLCJfc3luY19lc19pbmRleCIsImVzY2xpZW50IiwiZXNfaW5kZXhfbWFwcGluZyIsImtleXNwYWNlTmFtZSIsIm1hcHBpbmdOYW1lIiwiaW5kZXhOYW1lIiwiZWxhc3NhbmRyYUJ1aWxkZXIiLCJhc3NlcnRfaW5kZXgiLCJwdXRfbWFwcGluZyIsIl9zeW5jX2dyYXBoIiwiZ3JlbWxpbl9jbGllbnQiLCJncmFwaF9tYXBwaW5nIiwiZ3JhcGhOYW1lIiwiZ3JhcGhCdWlsZGVyIiwiYXNzZXJ0X2dyYXBoIiwiX2V4ZWN1dGVfdGFibGVfcXVlcnkiLCJxdWVyeSIsInBhcmFtcyIsIm9wdGlvbnMiLCJhcmd1bWVudHMiLCJkZWZhdWx0cyIsInByZXBhcmUiLCJkZWZhdWx0c0RlZXAiLCJkb0V4ZWN1dGVRdWVyeSIsImRvcXVlcnkiLCJkb2NhbGxiYWNrIiwiZXhlY3V0ZV9xdWVyeSIsImlzX3RhYmxlX3JlYWR5IiwiaW5pdCIsImdldF9maW5kX3F1ZXJ5IiwicXVlcnlPYmplY3QiLCJvcmRlcmJ5Q2xhdXNlIiwiZ2V0X29yZGVyYnlfY2xhdXNlIiwibGltaXRDbGF1c2UiLCJnZXRfbGltaXRfY2xhdXNlIiwid2hlcmVDbGF1c2UiLCJnZXRfd2hlcmVfY2xhdXNlIiwic2VsZWN0Q2xhdXNlIiwiZ2V0X3NlbGVjdF9jbGF1c2UiLCJncm91cGJ5Q2xhdXNlIiwiZ2V0X2dyb3VwYnlfY2xhdXNlIiwiZGlzdGluY3QiLCJtYXRlcmlhbGl6ZWRfdmlldyIsImFsbG93X2ZpbHRlcmluZyIsImdldF90YWJsZV9uYW1lIiwiZ2V0X2tleXNwYWNlX25hbWUiLCJfcmVhZHkiLCJ1bmRlZmluZWQiLCJzeW5jREIiLCJyZXN1bHQiLCJnZXRfY3FsX2NsaWVudCIsImVuc3VyZV9pbml0IiwiZ2V0X2VzX2NsaWVudCIsIkVycm9yIiwiZ2V0X2dyZW1saW5fY2xpZW50IiwiZXhlY3V0ZV9iYXRjaCIsImV4ZWN1dGVfZWFjaFJvdyIsIl9leGVjdXRlX3RhYmxlX2VhY2hSb3ciLCJvblJlYWRhYmxlIiwiZWFjaFJvdyIsImNiIiwicmF3IiwicmV0dXJuX3F1ZXJ5Iiwic2VsZWN0UXVlcnkiLCJmaW5kIiwicXVlcnlPcHRpb25zIiwibm9ybWFsaXplX3F1ZXJ5X29wdGlvbiIsIm4iLCJyb3ciLCJNb2RlbENvbnN0cnVjdG9yIiwiZ2V0X2NvbnN0cnVjdG9yIiwiZXhlY3V0ZV9zdHJlYW0iLCJfZXhlY3V0ZV90YWJsZV9zdHJlYW0iLCJzdHJlYW0iLCJzZWxmIiwicmVhZGVyIiwicmVhZFJvdyIsInJlYWQiLCJvIiwiX2V4ZWN1dGVfZ3JlbWxpbl9xdWVyeSIsInNjcmlwdCIsImJpbmRpbmdzIiwiZ3JlbWxpbkNsaWVudCIsImV4ZWN1dGUiLCJyZXN1bHRzIiwiX2V4ZWN1dGVfZ3JlbWxpbl9zY3JpcHQiLCJjcmVhdGVWZXJ0ZXgiLCJ2ZXJ0ZXhQcm9wZXJ0aWVzIiwiX19ncmFwaE5hbWUiLCJfX3ZlcnRleExhYmVsIiwiZm9yRWFjaCIsInByb3BlcnR5IiwiZ2V0VmVydGV4IiwiX192ZXJ0ZXhJZCIsInVwZGF0ZVZlcnRleCIsImRlbGV0ZVZlcnRleCIsImNyZWF0ZUVkZ2UiLCJfX2VkZ2VMYWJlbCIsIl9fZnJvbVZlcnRleElkIiwiX190b1ZlcnRleElkIiwiZWRnZVByb3BlcnRpZXMiLCJnZXRFZGdlIiwiX19lZGdlSWQiLCJ1cGRhdGVFZGdlIiwiZGVsZXRlRWRnZSIsImdyYXBoUXVlcnkiLCJzZWFyY2giLCJlc0NsaWVudCIsImluZGV4IiwidHlwZSIsInJlc3BvbnNlIiwic2VsZWN0IiwicXVlcnlQYXJhbXMiLCJmaW5kUXVlcnkiLCJjb25jYXQiLCJjYWxsYmFja19vcl90aHJvdyIsInJvd3MiLCJtYXAiLCJyZXMiLCJjb2x1bW5zIiwiZmluZE9uZSIsIiRsaW1pdCIsInVwZGF0ZSIsInVwZGF0ZVZhbHVlcyIsImJlZm9yZV91cGRhdGUiLCJnZXRfdXBkYXRlX3ZhbHVlX2V4cHJlc3Npb24iLCJ1cGRhdGVDbGF1c2VzIiwiZXJyb3JIYXBwZW5lZCIsIndoZXJlIiwiZmluYWxQYXJhbXMiLCJ0dGwiLCJqb2luIiwiY29uZGl0aW9ucyIsImlmQ2xhdXNlIiwiZ2V0X2lmX2NsYXVzZSIsImlmX2V4aXN0cyIsInJldHVybk9iaiIsImFmdGVyX2hvb2siLCJhZnRlcl91cGRhdGUiLCJkZWxldGUiLCJiZWZvcmVfZGVsZXRlIiwiYWZ0ZXJfZGVsZXRlIiwidHJ1bmNhdGUiLCJwcm90b3R5cGUiLCJnZXRfZGF0YV90eXBlcyIsInR5cGVzIiwiX2dldF9kZWZhdWx0X3ZhbHVlIiwiZmllbGRuYW1lIiwiaXNQbGFpbk9iamVjdCIsImRlZmF1bHQiLCJjYWxsIiwidmFsaWRhdGUiLCJ2YWx1ZSIsImdldF92YWxpZGF0aW9uX21lc3NhZ2UiLCJzYXZlIiwiZm4iLCJiZWZvcmVfc2F2ZSIsImdldF9zYXZlX3ZhbHVlX2V4cHJlc3Npb24iLCJpZGVudGlmaWVycyIsInZhbHVlcyIsImlmX25vdF9leGlzdCIsImFmdGVyX3NhdmUiLCJkZWxldGVRdWVyeSIsImZpZWxkS2V5IiwiaiIsInRvSlNPTiIsIm9iamVjdCIsImlzTW9kaWZpZWQiLCJoYXNPd25Qcm9wZXJ0eSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7O0FBQUEsSUFBTUEsVUFBVUMsUUFBUSxVQUFSLENBQWhCO0FBQ0EsSUFBTUMsSUFBSUQsUUFBUSxRQUFSLENBQVY7QUFDQSxJQUFNRSxPQUFPRixRQUFRLE1BQVIsQ0FBYjs7QUFFQSxJQUFJRyxrQkFBSjtBQUNBLElBQUk7QUFDRjtBQUNBQSxjQUFZSCxRQUFRLFlBQVIsQ0FBWjtBQUNELENBSEQsQ0FHRSxPQUFPSSxDQUFQLEVBQVU7QUFDVkQsY0FBWSxJQUFaO0FBQ0Q7O0FBRUQsSUFBTUUsTUFBTU4sUUFBUU8sWUFBUixDQUFxQkgsYUFBYUgsUUFBUSxrQkFBUixDQUFsQyxDQUFaOztBQUVBLElBQU1PLGFBQWFQLFFBQVEsbUJBQVIsQ0FBbkI7QUFDQSxJQUFNUSxVQUFVUixRQUFRLHNCQUFSLENBQWhCO0FBQ0EsSUFBTVMsYUFBYVQsUUFBUSxxQkFBUixDQUFuQjtBQUNBLElBQU1VLFNBQVNWLFFBQVEsaUJBQVIsQ0FBZjs7QUFFQSxJQUFNVyxlQUFlWCxRQUFRLG1CQUFSLENBQXJCO0FBQ0EsSUFBTVksb0JBQW9CWixRQUFRLHdCQUFSLENBQTFCO0FBQ0EsSUFBTWEsb0JBQW9CYixRQUFRLHdCQUFSLENBQTFCO0FBQ0EsSUFBTWMsU0FBU2QsUUFBUSxtQkFBUixDQUFmOztBQUVBLElBQU1lLFlBQVksU0FBU0MsQ0FBVCxDQUFXQyxjQUFYLEVBQTJCO0FBQzNDQSxtQkFBaUJBLGtCQUFrQixFQUFuQztBQUNBLE1BQU1DLGNBQWMsRUFBcEI7QUFDQSxNQUFNQyxTQUFTLEtBQUtDLFdBQUwsQ0FBaUJDLFdBQWpCLENBQTZCQyxNQUE3QixDQUFvQ0gsTUFBbkQ7QUFDQSxNQUFNSSxVQUFVLEtB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OztBQUVELFNBQU8sS0FBSzNQLFdBQUwsQ0FBaUJtTyxNQUFqQixDQUF3QnVCLFdBQXhCLEVBQXFDaEosT0FBckMsRUFBOEM1RCxRQUE5QyxDQUFQO0FBQ0QsQ0FyQkQ7O0FBdUJBbkQsVUFBVTRPLFNBQVYsQ0FBb0JzQixNQUFwQixHQUE2QixTQUFTQSxNQUFULEdBQWtCO0FBQUE7O0FBQzdDLE1BQU1DLFNBQVMsRUFBZjtBQUNBLE1BQU01UCxTQUFTLEtBQUtGLFdBQUwsQ0FBaUJDLFdBQWpCLENBQTZCQyxNQUE1Qzs7QUFFQVcsU0FBT0MsSUFBUCxDQUFZWixPQUFPSCxNQUFuQixFQUEyQm1MLE9BQTNCLENBQW1DLFVBQUMvSixLQUFELEVBQVc7QUFDNUMyTyxXQUFPM08sS0FBUCxJQUFnQixPQUFLQSxLQUFMLENBQWhCO0FBQ0QsR0FGRDs7QUFJQSxTQUFPMk8sTUFBUDtBQUNELENBVEQ7O0FBV0FuUSxVQUFVNE8sU0FBVixDQUFvQndCLFVBQXBCLEdBQWlDLFNBQVNBLFVBQVQsQ0FBb0J4UCxRQUFwQixFQUE4QjtBQUM3RCxNQUFJQSxRQUFKLEVBQWM7QUFDWixXQUFPTSxPQUFPME4sU0FBUCxDQUFpQnlCLGNBQWpCLENBQWdDbEIsSUFBaEMsQ0FBcUMsS0FBS3JPLFNBQTFDLEVBQXFERixRQUFyRCxDQUFQO0FBQ0Q7QUFDRCxTQUFPTSxPQUFPQyxJQUFQLENBQVksS0FBS0wsU0FBakIsRUFBNEJRLE1BQTVCLEtBQXVDLENBQTlDO0FBQ0QsQ0FMRDs7QUFPQWdQLE9BQU9DLE9BQVAsR0FBaUJ2USxTQUFqQiIsImZpbGUiOiJiYXNlX21vZGVsLmpzIiwic291cmNlc0NvbnRlbnQiOlsiY29uc3QgUHJvbWlzZSA9IHJlcXVpcmUoJ2JsdWViaXJkJyk7XG5jb25zdCBfID0gcmVxdWlyZSgnbG9kYXNoJyk7XG5jb25zdCB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuXG5sZXQgZHNlRHJpdmVyO1xudHJ5IHtcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGltcG9ydC9uby1leHRyYW5lb3VzLWRlcGVuZGVuY2llcywgaW1wb3J0L25vLXVucmVzb2x2ZWRcbiAgZHNlRHJpdmVyID0gcmVxdWlyZSgnZHNlLWRyaXZlcicpO1xufSBjYXRjaCAoZSkge1xuICBkc2VEcml2ZXIgPSBudWxsO1xufVxuXG5jb25zdCBjcWwgPSBQcm9taXNlLnByb21pc2lmeUFsbChkc2VEcml2ZXIgfHwgcmVxdWlyZSgnY2Fzc2FuZHJhLWRyaXZlcicpKTtcblxuY29uc3QgYnVpbGRFcnJvciA9IHJlcXVpcmUoJy4vYXBvbGxvX2Vycm9yLmpzJyk7XG5jb25zdCBzY2hlbWVyID0gcmVxdWlyZSgnLi4vdmFsaWRhdG9ycy9zY2hlbWEnKTtcbmNvbnN0IG5vcm1hbGl6ZXIgPSByZXF1aXJlKCcuLi91dGlscy9ub3JtYWxpemVyJyk7XG5jb25zdCBwYXJzZXIgPSByZXF1aXJlKCcuLi91dGlscy9wYXJzZXInKTtcblxuY29uc3QgVGFibGVCdWlsZGVyID0gcmVxdWlyZSgnLi4vYnVpbGRlcnMvdGFibGUnKTtcbmNvbnN0IEVsYXNzYW5kcmFCdWlsZGVyID0gcmVxdWlyZSgnLi4vYnVpbGRlcnMvZWxhc3NhbmRyYScpO1xuY29uc3QgSmFudXNHcmFwaEJ1aWxkZXIgPSByZXF1aXJlKCcuLi9idWlsZGVycy9qYW51c2dyYXBoJyk7XG5jb25zdCBEcml2ZXIgPSByZXF1aXJlKCcuLi9oZWxwZXJzL2RyaXZlcicpO1xuXG5jb25zdCBCYXNlTW9kZWwgPSBmdW5jdGlvbiBmKGluc3RhbmNlVmFsdWVzKSB7XG4gIGluc3RhbmNlVmFsdWVzID0gaW5zdGFuY2VWYWx1ZXMgfHwge307XG4gIGNvbnN0IGZpZWxkVmFsdWVzID0ge307XG4gIGNvbnN0IGZpZWxkcyA9IHRoaXMuY29uc3RydWN0b3IuX3Byb3BlcnRpZXMuc2NoZW1hLmZpZWxkcztcbiAgY29uc3QgbWV0aG9kcyA9IHRoaXMuY29uc3RydWN0b3IuX3Byb3BlcnRpZXMuc2NoZW1hLm1ldGhvZHMgfHwge307XG4gIGNvbnN0IG1vZGVsID0gdGhpcztcblxuICBjb25zdCBkZWZhdWx0U2V0dGVyID0gZnVuY3Rpb24gZjEocHJvcE5hbWUsIG5ld1ZhbHVlKSB7XG4gICAgaWYgKHRoaXNbcHJvcE5hbWVdICE9PSBuZXdWYWx1ZSkge1xuICAgICAgbW9kZWwuX21vZGlmaWVkW3Byb3BOYW1lXSA9IHRydWU7XG4gICAgfVxuICAgIHRoaXNbcHJvcE5hbWVdID0gbmV3VmFsdWU7XG4gIH07XG5cbiAgY29uc3QgZGVmYXVsdEdldHRlciA9IGZ1bmN0aW9uIGYxKHByb3BOYW1lKSB7XG4gICAgcmV0dXJuIHRoaXNbcHJvcE5hbWVdO1xuICB9O1xuXG4gIHRoaXMuX21vZGlmaWVkID0ge307XG4gIHRoaXMuX3ZhbGlkYXRvcnMgPSB7fTtcblxuICBmb3IgKGxldCBmaWVsZHNLZXlzID0gT2JqZWN0LmtleXMoZmllbGRzKSwgaSA9IDAsIGxlbiA9IGZpZWxkc0tleXMubGVuZ3RoOyBpIDwgbGVuOyBpKyspIHtcbiAgICBjb25zdCBwcm9wZXJ0eU5hbWUgPSBmaWVsZHNLZXlzW2ldO1xuICAgIGNvbnN0IGZpZWxkID0gZmllbGRzW2ZpZWxkc0tleXNbaV1dO1xuXG4gICAgdHJ5IHtcbiAgICAgIHRoaXMuX3ZhbGlkYXRvcnNbcHJvcGVydHlOYW1lXSA9IHNjaGVtZXIuZ2V0X3ZhbGlkYXRvcnModGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcy5zY2hlbWEsIHByb3BlcnR5TmFtZSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnZhbGlkYXRvci5pbnZhbGlkc2NoZW1hJywgZS5tZXNzYWdlKSk7XG4gICAgfVxuXG4gICAgbGV0IHNldHRlciA9IGRlZmF1bHRTZXR0ZXIuYmluZChmaWVsZFZhbHVlcywgcHJvcGVydHlOYW1lKTtcbiAgICBsZXQgZ2V0dGVyID0gZGVmYXVsdEdldHRlci5iaW5kKGZpZWxkVmFsdWVzLCBwcm9wZXJ0eU5hbWUpO1xuXG4gICAgaWYgKGZpZWxkLnZpcnR1YWwgJiYgdHlwZW9mIGZpZWxkLnZpcnR1YWwuc2V0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBzZXR0ZXIgPSBmaWVsZC52aXJ0dWFsLnNldC5iaW5kKGZpZWxkVmFsdWVzKTtcbiAgICB9XG5cbiAgICBpZiAoZmllbGQudmlydHVhbCAmJiB0eXBlb2YgZmllbGQudmlydHVhbC5nZXQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGdldHRlciA9IGZpZWxkLnZpcnR1YWwuZ2V0LmJpbmQoZmllbGRWYWx1ZXMpO1xuICAgIH1cblxuICAgIGNvbnN0IGRlc2NyaXB0b3IgPSB7XG4gICAgICBlbnVtZXJhYmxlOiB0cnVlLFxuICAgICAgc2V0OiBzZXR0ZXIsXG4gICAgICBnZXQ6IGdldHRlcixcbiAgICB9O1xuXG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHRoaXMsIHByb3BlcnR5TmFtZSwgZGVzY3JpcHRvcik7XG4gICAgaWYgKGZpZWxkLnZpcnR1YWwgJiYgdHlwZW9mIGluc3RhbmNlVmFsdWVzW3Byb3BlcnR5TmFtZV0gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICB0aGlzW3Byb3BlcnR5TmFtZV0gPSBpbnN0YW5jZVZhbHVlc1twcm9wZXJ0eU5hbWVdO1xuICAgIH1cbiAgfVxuXG4gIGZvciAobGV0IGZpZWxkc0tleXMgPSBPYmplY3Qua2V5cyhmaWVsZHMpLCBpID0gMCwgbGVuID0gZmllbGRzS2V5cy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICAgIGNvbnN0IHByb3BlcnR5TmFtZSA9IGZpZWxkc0tleXNbaV07XG4gICAgY29uc3QgZmllbGQgPSBmaWVsZHNbZmllbGRzS2V5c1tpXV07XG5cbiAgICBpZiAoIWZpZWxkLnZpcnR1YWwgJiYgdHlwZW9mIGluc3RhbmNlVmFsdWVzW3Byb3BlcnR5TmFtZV0gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICB0aGlzW3Byb3BlcnR5TmFtZV0gPSBpbnN0YW5jZVZhbHVlc1twcm9wZXJ0eU5hbWVdO1xuICAgIH1cbiAgfVxuXG4gIGZvciAobGV0IG1ldGhvZE5hbWVzID0gT2JqZWN0LmtleXMobWV0aG9kcyksIGkgPSAwLCBsZW4gPSBtZXRob2ROYW1lcy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICAgIGNvbnN0IG1ldGhvZE5hbWUgPSBtZXRob2ROYW1lc1tpXTtcbiAgICBjb25zdCBtZXRob2QgPSBtZXRob2RzW21ldGhvZE5hbWVdO1xuICAgIHRoaXNbbWV0aG9kTmFtZV0gPSBtZXRob2Q7XG4gIH1cbn07XG5cbkJhc2VNb2RlbC5fcHJvcGVydGllcyA9IHtcbiAgbmFtZTogbnVsbCxcbiAgc2NoZW1hOiBudWxsLFxufTtcblxuQmFzZU1vZGVsLl9zZXRfcHJvcGVydGllcyA9IGZ1bmN0aW9uIGYocHJvcGVydGllcykge1xuICBjb25zdCBzY2hlbWEgPSBwcm9wZXJ0aWVzLnNjaGVtYTtcbiAgY29uc3QgdGFibGVOYW1lID0gc2NoZW1hLnRhYmxlX25hbWUgfHwgcHJvcGVydGllcy5uYW1lO1xuXG4gIGlmICghc2NoZW1lci52YWxpZGF0ZV90YWJsZV9uYW1lKHRhYmxlTmFtZSkpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5pbnZhbGlkbmFtZScsIHRhYmxlTmFtZSkpO1xuICB9XG5cbiAgY29uc3QgcXVhbGlmaWVkVGFibGVOYW1lID0gdXRpbC5mb3JtYXQoJ1wiJXNcIi5cIiVzXCInLCBwcm9wZXJ0aWVzLmtleXNwYWNlLCB0YWJsZU5hbWUpO1xuXG4gIHRoaXMuX3Byb3BlcnRpZXMgPSBwcm9wZXJ0aWVzO1xuICB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWUgPSB0YWJsZU5hbWU7XG4gIHRoaXMuX3Byb3BlcnRpZXMucXVhbGlmaWVkX3RhYmxlX25hbWUgPSBxdWFsaWZpZWRUYWJsZU5hbWU7XG4gIHRoaXMuX2RyaXZlciA9IG5ldyBEcml2ZXIodGhpcy5fcHJvcGVydGllcyk7XG59O1xuXG5CYXNlTW9kZWwuX3N5bmNfbW9kZWxfZGVmaW5pdGlvbiA9IGZ1bmN0aW9uIGYoY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcbiAgY29uc3QgbW9kZWxTY2hlbWEgPSBwcm9wZXJ0aWVzLnNjaGVtYTtcbiAgbGV0IG1pZ3JhdGlvbiA9IHByb3BlcnRpZXMubWlncmF0aW9uO1xuXG4gIGNvbnN0IHRhYmxlQnVpbGRlciA9IG5ldyBUYWJsZUJ1aWxkZXIodGhpcy5fZHJpdmVyLCB0aGlzLl9wcm9wZXJ0aWVzKTtcblxuICAvLyBiYWNrd2FyZHMgY29tcGF0aWJsZSBjaGFuZ2UsIGRyb3BUYWJsZU9uU2NoZW1hQ2hhbmdlIHdpbGwgd29yayBsaWtlIG1pZ3JhdGlvbjogJ2Ryb3AnXG4gIGlmICghbWlncmF0aW9uKSB7XG4gICAgaWYgKHByb3BlcnRpZXMuZHJvcFRhYmxlT25TY2hlbWFDaGFuZ2UpIG1pZ3JhdGlvbiA9ICdkcm9wJztcbiAgICBlbHNlIG1pZ3JhdGlvbiA9ICdzYWZlJztcbiAgfVxuICAvLyBhbHdheXMgc2FmZSBtaWdyYXRlIGlmIE5PREVfRU5WPT09J3Byb2R1Y3Rpb24nXG4gIGlmIChwcm9jZXNzLmVudi5OT0RFX0VOViA9PT0gJ3Byb2R1Y3Rpb24nKSBtaWdyYXRpb24gPSAnc2FmZSc7XG5cbiAgLy8gY2hlY2sgZm9yIGV4aXN0ZW5jZSBvZiB0YWJsZSBvbiBEQiBhbmQgaWYgaXQgbWF0Y2hlcyB0aGlzIG1vZGVsJ3Mgc2NoZW1hXG4gIHRhYmxlQnVpbGRlci5nZXRfdGFibGVfc2NoZW1hKChlcnIsIGRiU2NoZW1hKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBhZnRlckRCQ3JlYXRlID0gKGVycjEpID0+IHtcbiAgICAgIGlmIChlcnIxKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycjEpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGluZGV4aW5nVGFza3MgPSBbXTtcblxuICAgICAgLy8gY2Fzc2FuZHJhIGluZGV4IGNyZWF0ZSBpZiBkZWZpbmVkXG4gICAgICBpZiAoXy5pc0FycmF5KG1vZGVsU2NoZW1hLmluZGV4ZXMpKSB7XG4gICAgICAgIHRhYmxlQnVpbGRlci5jcmVhdGVJbmRleGVzQXN5bmMgPSBQcm9taXNlLnByb21pc2lmeSh0YWJsZUJ1aWxkZXIuY3JlYXRlX2luZGV4ZXMpO1xuICAgICAgICBpbmRleGluZ1Rhc2tzLnB1c2godGFibGVCdWlsZGVyLmNyZWF0ZUluZGV4ZXNBc3luYyhtb2RlbFNjaGVtYS5pbmRleGVzKSk7XG4gICAgICB9XG4gICAgICAvLyBjYXNzYW5kcmEgY3VzdG9tIGluZGV4IGNyZWF0ZSBpZiBkZWZpbmVkXG4gICAgICBpZiAoXy5pc0FycmF5KG1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleGVzKSkge1xuICAgICAgICB0YWJsZUJ1aWxkZXIuY3JlYXRlQ3VzdG9tSW5kZXhlc0FzeW5jID0gUHJvbWlzZS5wcm9taXNpZnkodGFibGVCdWlsZGVyLmNyZWF0ZV9jdXN0b21faW5kZXhlcyk7XG4gICAgICAgIGluZGV4aW5nVGFza3MucHVzaCh0YWJsZUJ1aWxkZXIuY3JlYXRlQ3VzdG9tSW5kZXhlc0FzeW5jKG1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleGVzKSk7XG4gICAgICB9XG4gICAgICBpZiAobW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4KSB7XG4gICAgICAgIHRhYmxlQnVpbGRlci5jcmVhdGVDdXN0b21JbmRleEFzeW5jID0gUHJvbWlzZS5wcm9taXNpZnkodGFibGVCdWlsZGVyLmNyZWF0ZV9jdXN0b21faW5kZXhlcyk7XG4gICAgICAgIGluZGV4aW5nVGFza3MucHVzaCh0YWJsZUJ1aWxkZXIuY3JlYXRlQ3VzdG9tSW5kZXhBc3luYyhbbW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4XSkpO1xuICAgICAgfVxuICAgICAgLy8gbWF0ZXJpYWxpemVkIHZpZXcgY3JlYXRlIGlmIGRlZmluZWRcbiAgICAgIGlmIChtb2RlbFNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MpIHtcbiAgICAgICAgdGFibGVCdWlsZGVyLmNyZWF0ZVZpZXdzQXN5bmMgPSBQcm9taXNlLnByb21pc2lmeSh0YWJsZUJ1aWxkZXIuY3JlYXRlX212aWV3cyk7XG4gICAgICAgIGluZGV4aW5nVGFza3MucHVzaCh0YWJsZUJ1aWxkZXIuY3JlYXRlVmlld3NBc3luYyhtb2RlbFNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MpKTtcbiAgICAgIH1cblxuICAgICAgUHJvbWlzZS5hbGwoaW5kZXhpbmdUYXNrcylcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIC8vIGRiIHNjaGVtYSB3YXMgdXBkYXRlZCwgc28gY2FsbGJhY2sgd2l0aCB0cnVlXG4gICAgICAgICAgY2FsbGJhY2sobnVsbCwgdHJ1ZSk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZXJyMikgPT4ge1xuICAgICAgICAgIGNhbGxiYWNrKGVycjIpO1xuICAgICAgICB9KTtcbiAgICB9O1xuXG4gICAgaWYgKCFkYlNjaGVtYSkge1xuICAgICAgaWYgKHByb3BlcnRpZXMuY3JlYXRlVGFibGUgPT09IGZhbHNlKSB7XG4gICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbm90Zm91bmQnLCB0YWJsZU5hbWUpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgLy8gaWYgbm90IGV4aXN0aW5nLCBpdCdzIGNyZWF0ZWRcbiAgICAgIHRhYmxlQnVpbGRlci5jcmVhdGVfdGFibGUobW9kZWxTY2hlbWEsIGFmdGVyREJDcmVhdGUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxldCBub3JtYWxpemVkTW9kZWxTY2hlbWE7XG4gICAgbGV0IG5vcm1hbGl6ZWREQlNjaGVtYTtcblxuICAgIHRyeSB7XG4gICAgICBub3JtYWxpemVkTW9kZWxTY2hlbWEgPSBub3JtYWxpemVyLm5vcm1hbGl6ZV9tb2RlbF9zY2hlbWEobW9kZWxTY2hlbWEpO1xuICAgICAgbm9ybWFsaXplZERCU2NoZW1hID0gbm9ybWFsaXplci5ub3JtYWxpemVfbW9kZWxfc2NoZW1hKGRiU2NoZW1hKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRzY2hlbWEnLCBlLm1lc3NhZ2UpKTtcbiAgICB9XG5cbiAgICBpZiAoXy5pc0VxdWFsKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSwgbm9ybWFsaXplZERCU2NoZW1hKSkge1xuICAgICAgLy8gbm8gY2hhbmdlIGluIGRiIHdhcyBtYWRlLCBzbyBjYWxsYmFjayB3aXRoIGZhbHNlXG4gICAgICBjYWxsYmFjayhudWxsLCBmYWxzZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKG1pZ3JhdGlvbiA9PT0gJ2FsdGVyJykge1xuICAgICAgLy8gY2hlY2sgaWYgdGFibGUgY2FuIGJlIGFsdGVyZWQgdG8gbWF0Y2ggc2NoZW1hXG4gICAgICBpZiAoXy5pc0VxdWFsKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5rZXksIG5vcm1hbGl6ZWREQlNjaGVtYS5rZXkpICYmXG4gICAgICAgICAgXy5pc0VxdWFsKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5jbHVzdGVyaW5nX29yZGVyLCBub3JtYWxpemVkREJTY2hlbWEuY2x1c3RlcmluZ19vcmRlcikpIHtcbiAgICAgICAgdGFibGVCdWlsZGVyLmluaXRfYWx0ZXJfb3BlcmF0aW9ucyhtb2RlbFNjaGVtYSwgZGJTY2hlbWEsIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSwgbm9ybWFsaXplZERCU2NoZW1hLCAoZXJyMSkgPT4ge1xuICAgICAgICAgIGlmIChlcnIxICYmIGVycjEubWVzc2FnZSA9PT0gJ2FsdGVyX2ltcG9zc2libGUnKSB7XG4gICAgICAgICAgICB0YWJsZUJ1aWxkZXIuZHJvcF9yZWNyZWF0ZV90YWJsZShtb2RlbFNjaGVtYSwgbm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cywgYWZ0ZXJEQkNyZWF0ZSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGNhbGxiYWNrKGVycjEpO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRhYmxlQnVpbGRlci5kcm9wX3JlY3JlYXRlX3RhYmxlKG1vZGVsU2NoZW1hLCBub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzLCBhZnRlckRCQ3JlYXRlKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKG1pZ3JhdGlvbiA9PT0gJ2Ryb3AnKSB7XG4gICAgICB0YWJsZUJ1aWxkZXIuZHJvcF9yZWNyZWF0ZV90YWJsZShtb2RlbFNjaGVtYSwgbm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cywgYWZ0ZXJEQkNyZWF0ZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbWlzbWF0Y2gnLCB0YWJsZU5hbWUsICdtaWdyYXRpb24gc3VzcGVuZGVkLCBwbGVhc2UgYXBwbHkgdGhlIGNoYW5nZSBtYW51YWxseScpKTtcbiAgICB9XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLl9zeW5jX2VzX2luZGV4ID0gZnVuY3Rpb24gZihjYWxsYmFjaykge1xuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5fcHJvcGVydGllcztcblxuICBpZiAocHJvcGVydGllcy5lc2NsaWVudCAmJiBwcm9wZXJ0aWVzLnNjaGVtYS5lc19pbmRleF9tYXBwaW5nKSB7XG4gICAgY29uc3Qga2V5c3BhY2VOYW1lID0gcHJvcGVydGllcy5rZXlzcGFjZTtcbiAgICBjb25zdCBtYXBwaW5nTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcbiAgICBjb25zdCBpbmRleE5hbWUgPSBgJHtrZXlzcGFjZU5hbWV9XyR7bWFwcGluZ05hbWV9YDtcblxuICAgIGNvbnN0IGVsYXNzYW5kcmFCdWlsZGVyID0gbmV3IEVsYXNzYW5kcmFCdWlsZGVyKHByb3BlcnRpZXMuZXNjbGllbnQpO1xuICAgIGVsYXNzYW5kcmFCdWlsZGVyLmFzc2VydF9pbmRleChrZXlzcGFjZU5hbWUsIGluZGV4TmFtZSwgKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBlbGFzc2FuZHJhQnVpbGRlci5wdXRfbWFwcGluZyhpbmRleE5hbWUsIG1hcHBpbmdOYW1lLCBwcm9wZXJ0aWVzLnNjaGVtYS5lc19pbmRleF9tYXBwaW5nLCBjYWxsYmFjayk7XG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNhbGxiYWNrKCk7XG59O1xuXG5CYXNlTW9kZWwuX3N5bmNfZ3JhcGggPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuXG4gIGlmIChwcm9wZXJ0aWVzLmdyZW1saW5fY2xpZW50ICYmIHByb3BlcnRpZXMuc2NoZW1hLmdyYXBoX21hcHBpbmcpIHtcbiAgICBjb25zdCBncmFwaE5hbWUgPSBgJHtwcm9wZXJ0aWVzLmtleXNwYWNlfV9ncmFwaGA7XG4gICAgY29uc3QgbWFwcGluZ05hbWUgPSBwcm9wZXJ0aWVzLnRhYmxlX25hbWU7XG5cbiAgICBjb25zdCBncmFwaEJ1aWxkZXIgPSBuZXcgSmFudXNHcmFwaEJ1aWxkZXIocHJvcGVydGllcy5ncmVtbGluX2NsaWVudCk7XG4gICAgZ3JhcGhCdWlsZGVyLmFzc2VydF9ncmFwaChncmFwaE5hbWUsIChlcnIpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgZ3JhcGhCdWlsZGVyLnB1dF9tYXBwaW5nKGdyYXBoTmFtZSwgbWFwcGluZ05hbWUsIHByb3BlcnRpZXMuc2NoZW1hLmdyYXBoX21hcHBpbmcsIGNhbGxiYWNrKTtcbiAgICB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY2FsbGJhY2soKTtcbn07XG5cbkJhc2VNb2RlbC5fZXhlY3V0ZV90YWJsZV9xdWVyeSA9IGZ1bmN0aW9uIGYocXVlcnksIHBhcmFtcywgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDMpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIGNvbnN0IGRvRXhlY3V0ZVF1ZXJ5ID0gZnVuY3Rpb24gZjEoZG9xdWVyeSwgZG9jYWxsYmFjaykge1xuICAgIHRoaXMuZXhlY3V0ZV9xdWVyeShkb3F1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIGRvY2FsbGJhY2spO1xuICB9LmJpbmQodGhpcywgcXVlcnkpO1xuXG4gIGlmICh0aGlzLmlzX3RhYmxlX3JlYWR5KCkpIHtcbiAgICBkb0V4ZWN1dGVRdWVyeShjYWxsYmFjayk7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5pbml0KChlcnIpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgZG9FeGVjdXRlUXVlcnkoY2FsbGJhY2spO1xuICAgIH0pO1xuICB9XG59O1xuXG5CYXNlTW9kZWwuZ2V0X2ZpbmRfcXVlcnkgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0LCBvcHRpb25zKSB7XG4gIGNvbnN0IG9yZGVyYnlDbGF1c2UgPSBwYXJzZXIuZ2V0X29yZGVyYnlfY2xhdXNlKHF1ZXJ5T2JqZWN0KTtcbiAgY29uc3QgbGltaXRDbGF1c2UgPSBwYXJzZXIuZ2V0X2xpbWl0X2NsYXVzZShxdWVyeU9iamVjdCk7XG4gIGNvbnN0IHdoZXJlQ2xhdXNlID0gcGFyc2VyLmdldF93aGVyZV9jbGF1c2UodGhpcy5fcHJvcGVydGllcy5zY2hlbWEsIHF1ZXJ5T2JqZWN0KTtcbiAgY29uc3Qgc2VsZWN0Q2xhdXNlID0gcGFyc2VyLmdldF9zZWxlY3RfY2xhdXNlKG9wdGlvbnMpO1xuICBjb25zdCBncm91cGJ5Q2xhdXNlID0gcGFyc2VyLmdldF9ncm91cGJ5X2NsYXVzZShvcHRpb25zKTtcblxuICBsZXQgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAnU0VMRUNUICVzICVzIEZST00gXCIlc1wiICVzICVzICVzICVzJyxcbiAgICAob3B0aW9ucy5kaXN0aW5jdCA/ICdESVNUSU5DVCcgOiAnJyksXG4gICAgc2VsZWN0Q2xhdXNlLFxuICAgIG9wdGlvbnMubWF0ZXJpYWxpemVkX3ZpZXcgPyBvcHRpb25zLm1hdGVyaWFsaXplZF92aWV3IDogdGhpcy5fcHJvcGVydGllcy50YWJsZV9uYW1lLFxuICAgIHdoZXJlQ2xhdXNlLnF1ZXJ5LFxuICAgIG9yZGVyYnlDbGF1c2UsXG4gICAgZ3JvdXBieUNsYXVzZSxcbiAgICBsaW1pdENsYXVzZSxcbiAgKTtcblxuICBpZiAob3B0aW9ucy5hbGxvd19maWx0ZXJpbmcpIHF1ZXJ5ICs9ICcgQUxMT1cgRklMVEVSSU5HOyc7XG4gIGVsc2UgcXVlcnkgKz0gJzsnO1xuXG4gIHJldHVybiB7IHF1ZXJ5LCBwYXJhbXM6IHdoZXJlQ2xhdXNlLnBhcmFtcyB9O1xufTtcblxuQmFzZU1vZGVsLmdldF90YWJsZV9uYW1lID0gZnVuY3Rpb24gZigpIHtcbiAgcmV0dXJuIHRoaXMuX3Byb3BlcnRpZXMudGFibGVfbmFtZTtcbn07XG5cbkJhc2VNb2RlbC5nZXRfa2V5c3BhY2VfbmFtZSA9IGZ1bmN0aW9uIGYoKSB7XG4gIHJldHVybiB0aGlzLl9wcm9wZXJ0aWVzLmtleXNwYWNlO1xufTtcblxuQmFzZU1vZGVsLmlzX3RhYmxlX3JlYWR5ID0gZnVuY3Rpb24gZigpIHtcbiAgcmV0dXJuIHRoaXMuX3JlYWR5ID09PSB0cnVlO1xufTtcblxuQmFzZU1vZGVsLmluaXQgPSBmdW5jdGlvbiBmKG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gIGlmICghY2FsbGJhY2spIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHVuZGVmaW5lZDtcbiAgfVxuXG4gIHRoaXMuX3JlYWR5ID0gdHJ1ZTtcbiAgY2FsbGJhY2soKTtcbn07XG5cbkJhc2VNb2RlbC5zeW5jREIgPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIHRoaXMuX3N5bmNfbW9kZWxfZGVmaW5pdGlvbigoZXJyLCByZXN1bHQpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMuX3N5bmNfZXNfaW5kZXgoKGVycjEpID0+IHtcbiAgICAgIGlmIChlcnIxKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycjEpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIHRoaXMuX3N5bmNfZ3JhcGgoKGVycjIpID0+IHtcbiAgICAgICAgaWYgKGVycjIpIHtcbiAgICAgICAgICBjYWxsYmFjayhlcnIyKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLl9yZWFkeSA9IHRydWU7XG4gICAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuZ2V0X2NxbF9jbGllbnQgPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIHRoaXMuX2RyaXZlci5lbnN1cmVfaW5pdCgoZXJyKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY2FsbGJhY2sobnVsbCwgdGhpcy5fcHJvcGVydGllcy5jcWwpO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC5nZXRfZXNfY2xpZW50ID0gZnVuY3Rpb24gZigpIHtcbiAgaWYgKCF0aGlzLl9wcm9wZXJ0aWVzLmVzY2xpZW50KSB7XG4gICAgdGhyb3cgKG5ldyBFcnJvcignVG8gdXNlIGVsYXNzYW5kcmEgZmVhdHVyZXMsIHNldCBgbWFuYWdlRVNJbmRleGAgdG8gdHJ1ZSBpbiBvcm1PcHRpb25zJykpO1xuICB9XG4gIHJldHVybiB0aGlzLl9wcm9wZXJ0aWVzLmVzY2xpZW50O1xufTtcblxuQmFzZU1vZGVsLmdldF9ncmVtbGluX2NsaWVudCA9IGZ1bmN0aW9uIGYoKSB7XG4gIGlmICghdGhpcy5fcHJvcGVydGllcy5ncmVtbGluX2NsaWVudCkge1xuICAgIHRocm93IChuZXcgRXJyb3IoJ1RvIHVzZSBqYW51cyBncmFwaCBmZWF0dXJlcywgc2V0IGBtYW5hZ2VHcmFwaHNgIHRvIHRydWUgaW4gb3JtT3B0aW9ucycpKTtcbiAgfVxuICByZXR1cm4gdGhpcy5fcHJvcGVydGllcy5ncmVtbGluX2NsaWVudDtcbn07XG5cbkJhc2VNb2RlbC5leGVjdXRlX3F1ZXJ5ID0gZnVuY3Rpb24gZiguLi5hcmdzKSB7XG4gIHRoaXMuX2RyaXZlci5leGVjdXRlX3F1ZXJ5KC4uLmFyZ3MpO1xufTtcblxuQmFzZU1vZGVsLmV4ZWN1dGVfYmF0Y2ggPSBmdW5jdGlvbiBmKC4uLmFyZ3MpIHtcbiAgdGhpcy5fZHJpdmVyLmV4ZWN1dGVfYmF0Y2goLi4uYXJncyk7XG59O1xuXG5CYXNlTW9kZWwuZXhlY3V0ZV9lYWNoUm93ID0gZnVuY3Rpb24gZiguLi5hcmdzKSB7XG4gIHRoaXMuX2RyaXZlci5leGVjdXRlX2VhY2hSb3coLi4uYXJncyk7XG59O1xuXG5CYXNlTW9kZWwuX2V4ZWN1dGVfdGFibGVfZWFjaFJvdyA9IGZ1bmN0aW9uIGYocXVlcnksIHBhcmFtcywgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spIHtcbiAgaWYgKHRoaXMuaXNfdGFibGVfcmVhZHkoKSkge1xuICAgIHRoaXMuZXhlY3V0ZV9lYWNoUm93KHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKTtcbiAgfSBlbHNlIHtcbiAgICB0aGlzLmluaXQoKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aGlzLmV4ZWN1dGVfZWFjaFJvdyhxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjayk7XG4gICAgfSk7XG4gIH1cbn07XG5cbkJhc2VNb2RlbC5lYWNoUm93ID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCwgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDMpIHtcbiAgICBjb25zdCBjYiA9IG9uUmVhZGFibGU7XG4gICAgb25SZWFkYWJsZSA9IG9wdGlvbnM7XG4gICAgY2FsbGJhY2sgPSBjYjtcbiAgICBvcHRpb25zID0ge307XG4gIH1cbiAgaWYgKHR5cGVvZiBvblJlYWRhYmxlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuZWFjaHJvd2Vycm9yJywgJ25vIHZhbGlkIG9uUmVhZGFibGUgZnVuY3Rpb24gd2FzIHByb3ZpZGVkJykpO1xuICB9XG4gIGlmICh0eXBlb2YgY2FsbGJhY2sgIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5jYmVycm9yJykpO1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcmF3OiBmYWxzZSxcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgb3B0aW9ucy5yZXR1cm5fcXVlcnkgPSB0cnVlO1xuICBjb25zdCBzZWxlY3RRdWVyeSA9IHRoaXMuZmluZChxdWVyeU9iamVjdCwgb3B0aW9ucyk7XG5cbiAgY29uc3QgcXVlcnlPcHRpb25zID0gbm9ybWFsaXplci5ub3JtYWxpemVfcXVlcnlfb3B0aW9uKG9wdGlvbnMpO1xuXG4gIHRoaXMuX2V4ZWN1dGVfdGFibGVfZWFjaFJvdyhzZWxlY3RRdWVyeS5xdWVyeSwgc2VsZWN0UXVlcnkucGFyYW1zLCBxdWVyeU9wdGlvbnMsIChuLCByb3cpID0+IHtcbiAgICBpZiAoIW9wdGlvbnMucmF3KSB7XG4gICAgICBjb25zdCBNb2RlbENvbnN0cnVjdG9yID0gdGhpcy5fcHJvcGVydGllcy5nZXRfY29uc3RydWN0b3IoKTtcbiAgICAgIHJvdyA9IG5ldyBNb2RlbENvbnN0cnVjdG9yKHJvdyk7XG4gICAgICByb3cuX21vZGlmaWVkID0ge307XG4gICAgfVxuICAgIG9uUmVhZGFibGUobiwgcm93KTtcbiAgfSwgKGVyciwgcmVzdWx0KSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZmluZC5kYmVycm9yJywgZXJyKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNhbGxiYWNrKGVyciwgcmVzdWx0KTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuZXhlY3V0ZV9zdHJlYW0gPSBmdW5jdGlvbiBmKC4uLmFyZ3MpIHtcbiAgdGhpcy5fZHJpdmVyLmV4ZWN1dGVfc3RyZWFtKC4uLmFyZ3MpO1xufTtcblxuQmFzZU1vZGVsLl9leGVjdXRlX3RhYmxlX3N0cmVhbSA9IGZ1bmN0aW9uIGYocXVlcnksIHBhcmFtcywgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spIHtcbiAgaWYgKHRoaXMuaXNfdGFibGVfcmVhZHkoKSkge1xuICAgIHRoaXMuZXhlY3V0ZV9zdHJlYW0ocXVlcnksIHBhcmFtcywgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuaW5pdCgoZXJyKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRoaXMuZXhlY3V0ZV9zdHJlYW0ocXVlcnksIHBhcmFtcywgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spO1xuICAgIH0pO1xuICB9XG59O1xuXG5CYXNlTW9kZWwuc3RyZWFtID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCwgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDMpIHtcbiAgICBjb25zdCBjYiA9IG9uUmVhZGFibGU7XG4gICAgb25SZWFkYWJsZSA9IG9wdGlvbnM7XG4gICAgY2FsbGJhY2sgPSBjYjtcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBpZiAodHlwZW9mIG9uUmVhZGFibGUgIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5zdHJlYW1lcnJvcicsICdubyB2YWxpZCBvblJlYWRhYmxlIGZ1bmN0aW9uIHdhcyBwcm92aWRlZCcpKTtcbiAgfVxuICBpZiAodHlwZW9mIGNhbGxiYWNrICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuY2JlcnJvcicpKTtcbiAgfVxuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHJhdzogZmFsc2UsXG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIG9wdGlvbnMucmV0dXJuX3F1ZXJ5ID0gdHJ1ZTtcbiAgY29uc3Qgc2VsZWN0UXVlcnkgPSB0aGlzLmZpbmQocXVlcnlPYmplY3QsIG9wdGlvbnMpO1xuXG4gIGNvbnN0IHF1ZXJ5T3B0aW9ucyA9IG5vcm1hbGl6ZXIubm9ybWFsaXplX3F1ZXJ5X29wdGlvbihvcHRpb25zKTtcblxuICBjb25zdCBzZWxmID0gdGhpcztcblxuICB0aGlzLl9leGVjdXRlX3RhYmxlX3N0cmVhbShzZWxlY3RRdWVyeS5xdWVyeSwgc2VsZWN0UXVlcnkucGFyYW1zLCBxdWVyeU9wdGlvbnMsIGZ1bmN0aW9uIGYxKCkge1xuICAgIGNvbnN0IHJlYWRlciA9IHRoaXM7XG4gICAgcmVhZGVyLnJlYWRSb3cgPSAoKSA9PiB7XG4gICAgICBjb25zdCByb3cgPSByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKCFyb3cpIHJldHVybiByb3c7XG4gICAgICBpZiAoIW9wdGlvbnMucmF3KSB7XG4gICAgICAgIGNvbnN0IE1vZGVsQ29uc3RydWN0b3IgPSBzZWxmLl9wcm9wZXJ0aWVzLmdldF9jb25zdHJ1Y3RvcigpO1xuICAgICAgICBjb25zdCBvID0gbmV3IE1vZGVsQ29uc3RydWN0b3Iocm93KTtcbiAgICAgICAgby5fbW9kaWZpZWQgPSB7fTtcbiAgICAgICAgcmV0dXJuIG87XG4gICAgICB9XG4gICAgICByZXR1cm4gcm93O1xuICAgIH07XG4gICAgb25SZWFkYWJsZShyZWFkZXIpO1xuICB9LCAoZXJyKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZmluZC5kYmVycm9yJywgZXJyKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNhbGxiYWNrKCk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLl9leGVjdXRlX2dyZW1saW5fcXVlcnkgPSBmdW5jdGlvbiBmKHNjcmlwdCwgYmluZGluZ3MsIGNhbGxiYWNrKSB7XG4gIGNvbnN0IGdyZW1saW5DbGllbnQgPSB0aGlzLmdldF9ncmVtbGluX2NsaWVudCgpO1xuICBncmVtbGluQ2xpZW50LmV4ZWN1dGUoc2NyaXB0LCBiaW5kaW5ncywgKGVyciwgcmVzdWx0cykgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdHMpO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC5fZXhlY3V0ZV9ncmVtbGluX3NjcmlwdCA9IGZ1bmN0aW9uIGYoc2NyaXB0LCBiaW5kaW5ncywgY2FsbGJhY2spIHtcbiAgdGhpcy5fZXhlY3V0ZV9ncmVtbGluX3F1ZXJ5KHNjcmlwdCwgYmluZGluZ3MsIChlcnIsIHJlc3VsdHMpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjYWxsYmFjayhudWxsLCByZXN1bHRzWzBdKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuY3JlYXRlVmVydGV4ID0gZnVuY3Rpb24gZih2ZXJ0ZXhQcm9wZXJ0aWVzLCBjYWxsYmFjaykge1xuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5fcHJvcGVydGllcztcbiAgY29uc3QgX19ncmFwaE5hbWUgPSBgJHtwcm9wZXJ0aWVzLmtleXNwYWNlfV9ncmFwaGA7XG4gIGNvbnN0IF9fdmVydGV4TGFiZWwgPSBwcm9wZXJ0aWVzLnRhYmxlX25hbWU7XG4gIGxldCBzY3JpcHQgPSBgXG4gICAgZ3JhcGggPSBDb25maWd1cmVkR3JhcGhGYWN0b3J5Lm9wZW4oX19ncmFwaE5hbWUpO1xuICAgIHZlcnRleCA9IGdyYXBoLmFkZFZlcnRleChfX3ZlcnRleExhYmVsKTtcbiAgYDtcbiAgT2JqZWN0LmtleXModmVydGV4UHJvcGVydGllcykuZm9yRWFjaCgocHJvcGVydHkpID0+IHtcbiAgICBzY3JpcHQgKz0gYHZlcnRleC5wcm9wZXJ0eSgnJHtwcm9wZXJ0eX0nLCAke3Byb3BlcnR5fSk7YDtcbiAgfSk7XG4gIHNjcmlwdCArPSAndmVydGV4JztcbiAgY29uc3QgYmluZGluZ3MgPSBfLmRlZmF1bHRzKHZlcnRleFByb3BlcnRpZXMsIHtcbiAgICBfX2dyYXBoTmFtZSxcbiAgICBfX3ZlcnRleExhYmVsLFxuICB9KTtcbiAgdGhpcy5fZXhlY3V0ZV9ncmVtbGluX3NjcmlwdChzY3JpcHQsIGJpbmRpbmdzLCBjYWxsYmFjayk7XG59O1xuXG5CYXNlTW9kZWwuZ2V0VmVydGV4ID0gZnVuY3Rpb24gZihfX3ZlcnRleElkLCBjYWxsYmFjaykge1xuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5fcHJvcGVydGllcztcbiAgY29uc3QgX19ncmFwaE5hbWUgPSBgJHtwcm9wZXJ0aWVzLmtleXNwYWNlfV9ncmFwaGA7XG4gIGNvbnN0IHNjcmlwdCA9IGBcbiAgICBncmFwaCA9IENvbmZpZ3VyZWRHcmFwaEZhY3Rvcnkub3BlbihfX2dyYXBoTmFtZSk7XG4gICAgZyA9IGdyYXBoLnRyYXZlcnNhbCgpO1xuICAgIHZlcnRleCA9IGcuVihfX3ZlcnRleElkKTtcbiAgYDtcbiAgY29uc3QgYmluZGluZ3MgPSB7XG4gICAgX19ncmFwaE5hbWUsXG4gICAgX192ZXJ0ZXhJZCxcbiAgfTtcbiAgdGhpcy5fZXhlY3V0ZV9ncmVtbGluX3NjcmlwdChzY3JpcHQsIGJpbmRpbmdzLCBjYWxsYmFjayk7XG59O1xuXG5CYXNlTW9kZWwudXBkYXRlVmVydGV4ID0gZnVuY3Rpb24gZihfX3ZlcnRleElkLCB2ZXJ0ZXhQcm9wZXJ0aWVzLCBjYWxsYmFjaykge1xuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5fcHJvcGVydGllcztcbiAgY29uc3QgX19ncmFwaE5hbWUgPSBgJHtwcm9wZXJ0aWVzLmtleXNwYWNlfV9ncmFwaGA7XG4gIGxldCBzY3JpcHQgPSBgXG4gICAgZ3JhcGggPSBDb25maWd1cmVkR3JhcGhGYWN0b3J5Lm9wZW4oX19ncmFwaE5hbWUpO1xuICAgIGcgPSBncmFwaC50cmF2ZXJzYWwoKTtcbiAgICB2ZXJ0ZXggPSBnLlYoX192ZXJ0ZXhJZCk7XG4gIGA7XG4gIE9iamVjdC5rZXlzKHZlcnRleFByb3BlcnRpZXMpLmZvckVhY2goKHByb3BlcnR5KSA9PiB7XG4gICAgc2NyaXB0ICs9IGB2ZXJ0ZXgucHJvcGVydHkoJyR7cHJvcGVydHl9JywgJHtwcm9wZXJ0eX0pO2A7XG4gIH0pO1xuICBzY3JpcHQgKz0gJ3ZlcnRleCc7XG4gIGNvbnN0IGJpbmRpbmdzID0gXy5kZWZhdWx0cyh2ZXJ0ZXhQcm9wZXJ0aWVzLCB7XG4gICAgX19ncmFwaE5hbWUsXG4gICAgX192ZXJ0ZXhJZCxcbiAgfSk7XG4gIHRoaXMuX2V4ZWN1dGVfZ3JlbWxpbl9zY3JpcHQoc2NyaXB0LCBiaW5kaW5ncywgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLmRlbGV0ZVZlcnRleCA9IGZ1bmN0aW9uIGYoX192ZXJ0ZXhJZCwgY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IF9fZ3JhcGhOYW1lID0gYCR7cHJvcGVydGllcy5rZXlzcGFjZX1fZ3JhcGhgO1xuICBjb25zdCBzY3JpcHQgPSBgXG4gICAgZ3JhcGggPSBDb25maWd1cmVkR3JhcGhGYWN0b3J5Lm9wZW4oX19ncmFwaE5hbWUpO1xuICAgIGcgPSBncmFwaC50cmF2ZXJzYWwoKTtcbiAgICB2ZXJ0ZXggPSBnLlYoX192ZXJ0ZXhJZCk7XG4gICAgdmVydGV4LmRyb3AoKTtcbiAgYDtcbiAgY29uc3QgYmluZGluZ3MgPSB7XG4gICAgX19ncmFwaE5hbWUsXG4gICAgX192ZXJ0ZXhJZCxcbiAgfTtcbiAgdGhpcy5fZXhlY3V0ZV9ncmVtbGluX3NjcmlwdChzY3JpcHQsIGJpbmRpbmdzLCBjYWxsYmFjayk7XG59O1xuXG5CYXNlTW9kZWwuY3JlYXRlRWRnZSA9IGZ1bmN0aW9uIGYoX19lZGdlTGFiZWwsIF9fZnJvbVZlcnRleElkLCBfX3RvVmVydGV4SWQsIGVkZ2VQcm9wZXJ0aWVzLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gNCAmJiB0eXBlb2YgZWRnZVByb3BlcnRpZXMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYWxsYmFjayA9IGVkZ2VQcm9wZXJ0aWVzO1xuICAgIGVkZ2VQcm9wZXJ0aWVzID0ge307XG4gIH1cbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IF9fZ3JhcGhOYW1lID0gYCR7cHJvcGVydGllcy5rZXlzcGFjZX1fZ3JhcGhgO1xuICBsZXQgc2NyaXB0ID0gYFxuICAgIGdyYXBoID0gQ29uZmlndXJlZEdyYXBoRmFjdG9yeS5vcGVuKF9fZ3JhcGhOYW1lKTtcbiAgICBnID0gZ3JhcGgudHJhdmVyc2FsKCk7XG4gICAgZnJvbVZlcnRleCA9IGcuVihfX2Zyb21WZXJ0ZXhJZCkubmV4dCgpO1xuICAgIHRvVmVydGV4ID0gZy5WKF9fdG9WZXJ0ZXhJZCkubmV4dCgpO1xuICAgIGVkZ2UgPSBmcm9tVmVydGV4LmFkZEVkZ2UoX19lZGdlTGFiZWwsIHRvVmVydGV4KTtcbiAgYDtcbiAgT2JqZWN0LmtleXMoZWRnZVByb3BlcnRpZXMpLmZvckVhY2goKHByb3BlcnR5KSA9PiB7XG4gICAgc2NyaXB0ICs9IGBlZGdlLnByb3BlcnR5KCcke3Byb3BlcnR5fScsICR7cHJvcGVydHl9KTtgO1xuICB9KTtcbiAgc2NyaXB0ICs9ICdlZGdlJztcbiAgY29uc3QgYmluZGluZ3MgPSBfLmRlZmF1bHRzKGVkZ2VQcm9wZXJ0aWVzLCB7XG4gICAgX19ncmFwaE5hbWUsXG4gICAgX19mcm9tVmVydGV4SWQsXG4gICAgX190b1ZlcnRleElkLFxuICAgIF9fZWRnZUxhYmVsLFxuICB9KTtcbiAgdGhpcy5fZXhlY3V0ZV9ncmVtbGluX3NjcmlwdChzY3JpcHQsIGJpbmRpbmdzLCBjYWxsYmFjayk7XG59O1xuXG5CYXNlTW9kZWwuZ2V0RWRnZSA9IGZ1bmN0aW9uIGYoX19lZGdlSWQsIGNhbGxiYWNrKSB7XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICBjb25zdCBfX2dyYXBoTmFtZSA9IGAke3Byb3BlcnRpZXMua2V5c3BhY2V9X2dyYXBoYDtcbiAgY29uc3Qgc2NyaXB0ID0gYFxuICAgIGdyYXBoID0gQ29uZmlndXJlZEdyYXBoRmFjdG9yeS5vcGVuKF9fZ3JhcGhOYW1lKTtcbiAgICBnID0gZ3JhcGgudHJhdmVyc2FsKCk7XG4gICAgZWRnZSA9IGcuRShfX2VkZ2VJZCk7XG4gIGA7XG4gIGNvbnN0IGJpbmRpbmdzID0ge1xuICAgIF9fZ3JhcGhOYW1lLFxuICAgIF9fZWRnZUlkLFxuICB9O1xuICB0aGlzLl9leGVjdXRlX2dyZW1saW5fc2NyaXB0KHNjcmlwdCwgYmluZGluZ3MsIGNhbGxiYWNrKTtcbn07XG5cbkJhc2VNb2RlbC51cGRhdGVFZGdlID0gZnVuY3Rpb24gZihfX2VkZ2VJZCwgZWRnZVByb3BlcnRpZXMsIGNhbGxiYWNrKSB7XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICBjb25zdCBfX2dyYXBoTmFtZSA9IGAke3Byb3BlcnRpZXMua2V5c3BhY2V9X2dyYXBoYDtcbiAgbGV0IHNjcmlwdCA9IGBcbiAgICBncmFwaCA9IENvbmZpZ3VyZWRHcmFwaEZhY3Rvcnkub3BlbihfX2dyYXBoTmFtZSk7XG4gICAgZyA9IGdyYXBoLnRyYXZlcnNhbCgpO1xuICAgIGVkZ2UgPSBnLkUoX19lZGdlSWQpO1xuICBgO1xuICBPYmplY3Qua2V5cyhlZGdlUHJvcGVydGllcykuZm9yRWFjaCgocHJvcGVydHkpID0+IHtcbiAgICBzY3JpcHQgKz0gYGVkZ2UucHJvcGVydHkoJyR7cHJvcGVydHl9JywgJHtwcm9wZXJ0eX0pO2A7XG4gIH0pO1xuICBzY3JpcHQgKz0gJ2VkZ2UnO1xuICBjb25zdCBiaW5kaW5ncyA9IF8uZGVmYXVsdHMoZWRnZVByb3BlcnRpZXMsIHtcbiAgICBfX2dyYXBoTmFtZSxcbiAgICBfX2VkZ2VJZCxcbiAgfSk7XG4gIHRoaXMuX2V4ZWN1dGVfZ3JlbWxpbl9zY3JpcHQoc2NyaXB0LCBiaW5kaW5ncywgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLmRlbGV0ZUVkZ2UgPSBmdW5jdGlvbiBmKF9fZWRnZUlkLCBjYWxsYmFjaykge1xuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5fcHJvcGVydGllcztcbiAgY29uc3QgX19ncmFwaE5hbWUgPSBgJHtwcm9wZXJ0aWVzLmtleXNwYWNlfV9ncmFwaGA7XG4gIGNvbnN0IHNjcmlwdCA9IGBcbiAgICBncmFwaCA9IENvbmZpZ3VyZWRHcmFwaEZhY3Rvcnkub3BlbihfX2dyYXBoTmFtZSk7XG4gICAgZyA9IGdyYXBoLnRyYXZlcnNhbCgpO1xuICAgIGVkZ2UgPSBnLkUoX19lZGdlSWQpO1xuICAgIGVkZ2UuZHJvcCgpO1xuICBgO1xuICBjb25zdCBiaW5kaW5ncyA9IHtcbiAgICBfX2dyYXBoTmFtZSxcbiAgICBfX2VkZ2VJZCxcbiAgfTtcbiAgdGhpcy5fZXhlY3V0ZV9ncmVtbGluX3NjcmlwdChzY3JpcHQsIGJpbmRpbmdzLCBjYWxsYmFjayk7XG59O1xuXG5CYXNlTW9kZWwuZ3JhcGhRdWVyeSA9IGZ1bmN0aW9uIGYocXVlcnksIHBhcmFtcywgY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IF9fZ3JhcGhOYW1lID0gYCR7cHJvcGVydGllcy5rZXlzcGFjZX1fZ3JhcGhgO1xuICBjb25zdCBfX3ZlcnRleExhYmVsID0gcHJvcGVydGllcy50YWJsZV9uYW1lO1xuICBsZXQgc2NyaXB0ID0gYFxuICAgIGdyYXBoID0gQ29uZmlndXJlZEdyYXBoRmFjdG9yeS5vcGVuKF9fZ3JhcGhOYW1lKTtcbiAgICBnID0gZ3JhcGgudHJhdmVyc2FsKCk7XG4gICAgdmVydGljZXMgPSBnLlYoKS5oYXNMYWJlbChfX3ZlcnRleExhYmVsKTtcbiAgYDtcbiAgc2NyaXB0ICs9IHF1ZXJ5O1xuICBjb25zdCBiaW5kaW5ncyA9IF8uZGVmYXVsdHMocGFyYW1zLCB7XG4gICAgX19ncmFwaE5hbWUsXG4gICAgX192ZXJ0ZXhMYWJlbCxcbiAgfSk7XG4gIHRoaXMuX2V4ZWN1dGVfZ3JlbWxpbl9xdWVyeShzY3JpcHQsIGJpbmRpbmdzLCBjYWxsYmFjayk7XG59O1xuXG5CYXNlTW9kZWwuc2VhcmNoID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCwgY2FsbGJhY2spIHtcbiAgY29uc3QgZXNDbGllbnQgPSB0aGlzLmdldF9lc19jbGllbnQoKTtcbiAgY29uc3QgaW5kZXhOYW1lID0gYCR7dGhpcy5fcHJvcGVydGllcy5rZXlzcGFjZX1fJHt0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWV9YDtcblxuICBjb25zdCBxdWVyeSA9IF8uZGVmYXVsdHMocXVlcnlPYmplY3QsIHtcbiAgICBpbmRleDogaW5kZXhOYW1lLFxuICAgIHR5cGU6IHRoaXMuX3Byb3BlcnRpZXMudGFibGVfbmFtZSxcbiAgfSk7XG4gIGVzQ2xpZW50LnNlYXJjaChxdWVyeSwgKGVyciwgcmVzcG9uc2UpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjYWxsYmFjayhudWxsLCByZXNwb25zZSk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLmZpbmQgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMiAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cbiAgaWYgKHR5cGVvZiBjYWxsYmFjayAhPT0gJ2Z1bmN0aW9uJyAmJiAhb3B0aW9ucy5yZXR1cm5fcXVlcnkpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5jYmVycm9yJykpO1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcmF3OiBmYWxzZSxcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgLy8gc2V0IHJhdyB0cnVlIGlmIHNlbGVjdCBpcyB1c2VkLFxuICAvLyBiZWNhdXNlIGNhc3RpbmcgdG8gbW9kZWwgaW5zdGFuY2VzIG1heSBsZWFkIHRvIHByb2JsZW1zXG4gIGlmIChvcHRpb25zLnNlbGVjdCkgb3B0aW9ucy5yYXcgPSB0cnVlO1xuXG4gIGxldCBxdWVyeVBhcmFtcyA9IFtdO1xuXG4gIGxldCBxdWVyeTtcbiAgdHJ5IHtcbiAgICBjb25zdCBmaW5kUXVlcnkgPSB0aGlzLmdldF9maW5kX3F1ZXJ5KHF1ZXJ5T2JqZWN0LCBvcHRpb25zKTtcbiAgICBxdWVyeSA9IGZpbmRRdWVyeS5xdWVyeTtcbiAgICBxdWVyeVBhcmFtcyA9IHF1ZXJ5UGFyYW1zLmNvbmNhdChmaW5kUXVlcnkucGFyYW1zKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHBhcnNlci5jYWxsYmFja19vcl90aHJvdyhlLCBjYWxsYmFjayk7XG4gICAgcmV0dXJuIHt9O1xuICB9XG5cbiAgaWYgKG9wdGlvbnMucmV0dXJuX3F1ZXJ5KSB7XG4gICAgcmV0dXJuIHsgcXVlcnksIHBhcmFtczogcXVlcnlQYXJhbXMgfTtcbiAgfVxuXG4gIGNvbnN0IHF1ZXJ5T3B0aW9ucyA9IG5vcm1hbGl6ZXIubm9ybWFsaXplX3F1ZXJ5X29wdGlvbihvcHRpb25zKTtcblxuICB0aGlzLl9leGVjdXRlX3RhYmxlX3F1ZXJ5KHF1ZXJ5LCBxdWVyeVBhcmFtcywgcXVlcnlPcHRpb25zLCAoZXJyLCByZXN1bHRzKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZmluZC5kYmVycm9yJywgZXJyKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghb3B0aW9ucy5yYXcpIHtcbiAgICAgIGNvbnN0IE1vZGVsQ29uc3RydWN0b3IgPSB0aGlzLl9wcm9wZXJ0aWVzLmdldF9jb25zdHJ1Y3RvcigpO1xuICAgICAgcmVzdWx0cyA9IHJlc3VsdHMucm93cy5tYXAoKHJlcykgPT4ge1xuICAgICAgICBkZWxldGUgKHJlcy5jb2x1bW5zKTtcbiAgICAgICAgY29uc3QgbyA9IG5ldyBNb2RlbENvbnN0cnVjdG9yKHJlcyk7XG4gICAgICAgIG8uX21vZGlmaWVkID0ge307XG4gICAgICAgIHJldHVybiBvO1xuICAgICAgfSk7XG4gICAgICBjYWxsYmFjayhudWxsLCByZXN1bHRzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVzdWx0cyA9IHJlc3VsdHMucm93cy5tYXAoKHJlcykgPT4ge1xuICAgICAgICBkZWxldGUgKHJlcy5jb2x1bW5zKTtcbiAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgIH0pO1xuICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0cyk7XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4ge307XG59O1xuXG5CYXNlTW9kZWwuZmluZE9uZSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAyICYmIHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB7fTtcbiAgfVxuICBpZiAodHlwZW9mIGNhbGxiYWNrICE9PSAnZnVuY3Rpb24nICYmICFvcHRpb25zLnJldHVybl9xdWVyeSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmNiZXJyb3InKSk7XG4gIH1cblxuICBxdWVyeU9iamVjdC4kbGltaXQgPSAxO1xuXG4gIHJldHVybiB0aGlzLmZpbmQocXVlcnlPYmplY3QsIG9wdGlvbnMsIChlcnIsIHJlc3VsdHMpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICBjYWxsYmFjayhudWxsLCByZXN1bHRzWzBdKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY2FsbGJhY2soKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwudXBkYXRlID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCwgdXBkYXRlVmFsdWVzLCBvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMyAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBjb25zdCBzY2hlbWEgPSB0aGlzLl9wcm9wZXJ0aWVzLnNjaGVtYTtcblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgaWYgKHR5cGVvZiBzY2hlbWEuYmVmb3JlX3VwZGF0ZSA9PT0gJ2Z1bmN0aW9uJyAmJiBzY2hlbWEuYmVmb3JlX3VwZGF0ZShxdWVyeU9iamVjdCwgdXBkYXRlVmFsdWVzLCBvcHRpb25zKSA9PT0gZmFsc2UpIHtcbiAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmJlZm9yZS5lcnJvcicpLCBjYWxsYmFjayk7XG4gICAgcmV0dXJuIHt9O1xuICB9XG5cbiAgY29uc3QgeyB1cGRhdGVDbGF1c2VzLCBxdWVyeVBhcmFtcywgZXJyb3JIYXBwZW5lZCB9ID0gcGFyc2VyLmdldF91cGRhdGVfdmFsdWVfZXhwcmVzc2lvbihcbiAgICB0aGlzLFxuICAgIHNjaGVtYSxcbiAgICB1cGRhdGVWYWx1ZXMsXG4gICAgY2FsbGJhY2ssXG4gICk7XG5cbiAgaWYgKGVycm9ySGFwcGVuZWQpIHJldHVybiB7fTtcblxuICBsZXQgcXVlcnkgPSAnVVBEQVRFIFwiJXNcIic7XG4gIGxldCB3aGVyZSA9ICcnO1xuICBsZXQgZmluYWxQYXJhbXMgPSBxdWVyeVBhcmFtcztcbiAgaWYgKG9wdGlvbnMudHRsKSBxdWVyeSArPSB1dGlsLmZvcm1hdCgnIFVTSU5HIFRUTCAlcycsIG9wdGlvbnMudHRsKTtcbiAgcXVlcnkgKz0gJyBTRVQgJXMgJXMnO1xuICB0cnkge1xuICAgIGNvbnN0IHdoZXJlQ2xhdXNlID0gcGFyc2VyLmdldF93aGVyZV9jbGF1c2Uoc2NoZW1hLCBxdWVyeU9iamVjdCk7XG4gICAgd2hlcmUgPSB3aGVyZUNsYXVzZS5xdWVyeTtcbiAgICBmaW5hbFBhcmFtcyA9IGZpbmFsUGFyYW1zLmNvbmNhdCh3aGVyZUNsYXVzZS5wYXJhbXMpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGUsIGNhbGxiYWNrKTtcbiAgICByZXR1cm4ge307XG4gIH1cblxuICBxdWVyeSA9IHV0aWwuZm9ybWF0KHF1ZXJ5LCB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWUsIHVwZGF0ZUNsYXVzZXMuam9pbignLCAnKSwgd2hlcmUpO1xuXG4gIGlmIChvcHRpb25zLmNvbmRpdGlvbnMpIHtcbiAgICBjb25zdCBpZkNsYXVzZSA9IHBhcnNlci5nZXRfaWZfY2xhdXNlKHNjaGVtYSwgb3B0aW9ucy5jb25kaXRpb25zKTtcbiAgICBpZiAoaWZDbGF1c2UucXVlcnkpIHtcbiAgICAgIHF1ZXJ5ICs9IHV0aWwuZm9ybWF0KCcgJXMnLCBpZkNsYXVzZS5xdWVyeSk7XG4gICAgICBmaW5hbFBhcmFtcyA9IGZpbmFsUGFyYW1zLmNvbmNhdChpZkNsYXVzZS5wYXJhbXMpO1xuICAgIH1cbiAgfSBlbHNlIGlmIChvcHRpb25zLmlmX2V4aXN0cykge1xuICAgIHF1ZXJ5ICs9ICcgSUYgRVhJU1RTJztcbiAgfVxuXG4gIHF1ZXJ5ICs9ICc7JztcblxuICBpZiAob3B0aW9ucy5yZXR1cm5fcXVlcnkpIHtcbiAgICBjb25zdCByZXR1cm5PYmogPSB7XG4gICAgICBxdWVyeSxcbiAgICAgIHBhcmFtczogZmluYWxQYXJhbXMsXG4gICAgICBhZnRlcl9ob29rOiAoKSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2Ygc2NoZW1hLmFmdGVyX3VwZGF0ZSA9PT0gJ2Z1bmN0aW9uJyAmJiBzY2hlbWEuYWZ0ZXJfdXBkYXRlKHF1ZXJ5T2JqZWN0LCB1cGRhdGVWYWx1ZXMsIG9wdGlvbnMpID09PSBmYWxzZSkge1xuICAgICAgICAgIHJldHVybiBidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuYWZ0ZXIuZXJyb3InKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgfTtcbiAgICByZXR1cm4gcmV0dXJuT2JqO1xuICB9XG5cbiAgY29uc3QgcXVlcnlPcHRpb25zID0gbm9ybWFsaXplci5ub3JtYWxpemVfcXVlcnlfb3B0aW9uKG9wdGlvbnMpO1xuXG4gIHRoaXMuX2V4ZWN1dGVfdGFibGVfcXVlcnkocXVlcnksIGZpbmFsUGFyYW1zLCBxdWVyeU9wdGlvbnMsIChlcnIsIHJlc3VsdHMpID0+IHtcbiAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5kYmVycm9yJywgZXJyKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2Ygc2NoZW1hLmFmdGVyX3VwZGF0ZSA9PT0gJ2Z1bmN0aW9uJyAmJiBzY2hlbWEuYWZ0ZXJfdXBkYXRlKHF1ZXJ5T2JqZWN0LCB1cGRhdGVWYWx1ZXMsIG9wdGlvbnMpID09PSBmYWxzZSkge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuYWZ0ZXIuZXJyb3InKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdHMpO1xuICAgIH0gZWxzZSBpZiAoZXJyKSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmRiZXJyb3InLCBlcnIpKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfdXBkYXRlID09PSAnZnVuY3Rpb24nICYmIHNjaGVtYS5hZnRlcl91cGRhdGUocXVlcnlPYmplY3QsIHVwZGF0ZVZhbHVlcywgb3B0aW9ucykgPT09IGZhbHNlKSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmFmdGVyLmVycm9yJykpO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHt9O1xufTtcblxuQmFzZU1vZGVsLmRlbGV0ZSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAyICYmIHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB7fTtcbiAgfVxuXG4gIGNvbnN0IHNjaGVtYSA9IHRoaXMuX3Byb3BlcnRpZXMuc2NoZW1hO1xuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHByZXBhcmU6IHRydWUsXG4gIH07XG5cbiAgb3B0aW9ucyA9IF8uZGVmYXVsdHNEZWVwKG9wdGlvbnMsIGRlZmF1bHRzKTtcblxuICBpZiAodHlwZW9mIHNjaGVtYS5iZWZvcmVfZGVsZXRlID09PSAnZnVuY3Rpb24nICYmIHNjaGVtYS5iZWZvcmVfZGVsZXRlKHF1ZXJ5T2JqZWN0LCBvcHRpb25zKSA9PT0gZmFsc2UpIHtcbiAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coYnVpbGRFcnJvcignbW9kZWwuZGVsZXRlLmJlZm9yZS5lcnJvcicpLCBjYWxsYmFjayk7XG4gICAgcmV0dXJuIHt9O1xuICB9XG5cbiAgbGV0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgbGV0IHF1ZXJ5ID0gJ0RFTEVURSBGUk9NIFwiJXNcIiAlczsnO1xuICBsZXQgd2hlcmUgPSAnJztcbiAgdHJ5IHtcbiAgICBjb25zdCB3aGVyZUNsYXVzZSA9IHBhcnNlci5nZXRfd2hlcmVfY2xhdXNlKHNjaGVtYSwgcXVlcnlPYmplY3QpO1xuICAgIHdoZXJlID0gd2hlcmVDbGF1c2UucXVlcnk7XG4gICAgcXVlcnlQYXJhbXMgPSBxdWVyeVBhcmFtcy5jb25jYXQod2hlcmVDbGF1c2UucGFyYW1zKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHBhcnNlci5jYWxsYmFja19vcl90aHJvdyhlLCBjYWxsYmFjayk7XG4gICAgcmV0dXJuIHt9O1xuICB9XG5cbiAgcXVlcnkgPSB1dGlsLmZvcm1hdChxdWVyeSwgdGhpcy5fcHJvcGVydGllcy50YWJsZV9uYW1lLCB3aGVyZSk7XG5cbiAgaWYgKG9wdGlvbnMucmV0dXJuX3F1ZXJ5KSB7XG4gICAgY29uc3QgcmV0dXJuT2JqID0ge1xuICAgICAgcXVlcnksXG4gICAgICBwYXJhbXM6IHF1ZXJ5UGFyYW1zLFxuICAgICAgYWZ0ZXJfaG9vazogKCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHNjaGVtYS5hZnRlcl9kZWxldGUgPT09ICdmdW5jdGlvbicgJiYgc2NoZW1hLmFmdGVyX2RlbGV0ZShxdWVyeU9iamVjdCwgb3B0aW9ucykgPT09IGZhbHNlKSB7XG4gICAgICAgICAgcmV0dXJuIGJ1aWxkRXJyb3IoJ21vZGVsLmRlbGV0ZS5hZnRlci5lcnJvcicpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICB9O1xuICAgIHJldHVybiByZXR1cm5PYmo7XG4gIH1cblxuICBjb25zdCBxdWVyeU9wdGlvbnMgPSBub3JtYWxpemVyLm5vcm1hbGl6ZV9xdWVyeV9vcHRpb24ob3B0aW9ucyk7XG5cbiAgdGhpcy5fZXhlY3V0ZV90YWJsZV9xdWVyeShxdWVyeSwgcXVlcnlQYXJhbXMsIHF1ZXJ5T3B0aW9ucywgKGVyciwgcmVzdWx0cykgPT4ge1xuICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZGVsZXRlLmRiZXJyb3InLCBlcnIpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfZGVsZXRlID09PSAnZnVuY3Rpb24nICYmIHNjaGVtYS5hZnRlcl9kZWxldGUocXVlcnlPYmplY3QsIG9wdGlvbnMpID09PSBmYWxzZSkge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5kZWxldGUuYWZ0ZXIuZXJyb3InKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdHMpO1xuICAgIH0gZWxzZSBpZiAoZXJyKSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZGVsZXRlLmRiZXJyb3InLCBlcnIpKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfZGVsZXRlID09PSAnZnVuY3Rpb24nICYmIHNjaGVtYS5hZnRlcl9kZWxldGUocXVlcnlPYmplY3QsIG9wdGlvbnMpID09PSBmYWxzZSkge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmRlbGV0ZS5hZnRlci5lcnJvcicpKTtcbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiB7fTtcbn07XG5cbkJhc2VNb2RlbC50cnVuY2F0ZSA9IGZ1bmN0aW9uIGYoY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcblxuICBjb25zdCBxdWVyeSA9IHV0aWwuZm9ybWF0KCdUUlVOQ0FURSBUQUJMRSBcIiVzXCI7JywgdGFibGVOYW1lKTtcbiAgdGhpcy5fZXhlY3V0ZV90YWJsZV9xdWVyeShxdWVyeSwgW10sIGNhbGxiYWNrKTtcbn07XG5cbkJhc2VNb2RlbC5wcm90b3R5cGUuZ2V0X2RhdGFfdHlwZXMgPSBmdW5jdGlvbiBmKCkge1xuICByZXR1cm4gY3FsLnR5cGVzO1xufTtcblxuQmFzZU1vZGVsLnByb3RvdHlwZS5nZXRfdGFibGVfbmFtZSA9IGZ1bmN0aW9uIGYoKSB7XG4gIHJldHVybiB0aGlzLmNvbnN0cnVjdG9yLmdldF90YWJsZV9uYW1lKCk7XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLmdldF9rZXlzcGFjZV9uYW1lID0gZnVuY3Rpb24gZigpIHtcbiAgcmV0dXJuIHRoaXMuY29uc3RydWN0b3IuZ2V0X2tleXNwYWNlX25hbWUoKTtcbn07XG5cbkJhc2VNb2RlbC5wcm90b3R5cGUuX2dldF9kZWZhdWx0X3ZhbHVlID0gZnVuY3Rpb24gZihmaWVsZG5hbWUpIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuY29uc3RydWN0b3IuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IHNjaGVtYSA9IHByb3BlcnRpZXMuc2NoZW1hO1xuXG4gIGlmIChfLmlzUGxhaW5PYmplY3Qoc2NoZW1hLmZpZWxkc1tmaWVsZG5hbWVdKSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkbmFtZV0uZGVmYXVsdCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBzY2hlbWEuZmllbGRzW2ZpZWxkbmFtZV0uZGVmYXVsdCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgcmV0dXJuIHNjaGVtYS5maWVsZHNbZmllbGRuYW1lXS5kZWZhdWx0LmNhbGwodGhpcyk7XG4gICAgfVxuICAgIHJldHVybiBzY2hlbWEuZmllbGRzW2ZpZWxkbmFtZV0uZGVmYXVsdDtcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufTtcblxuQmFzZU1vZGVsLnByb3RvdHlwZS52YWxpZGF0ZSA9IGZ1bmN0aW9uIGYocHJvcGVydHlOYW1lLCB2YWx1ZSkge1xuICB2YWx1ZSA9IHZhbHVlIHx8IHRoaXNbcHJvcGVydHlOYW1lXTtcbiAgdGhpcy5fdmFsaWRhdG9ycyA9IHRoaXMuX3ZhbGlkYXRvcnMgfHwge307XG4gIHJldHVybiBzY2hlbWVyLmdldF92YWxpZGF0aW9uX21lc3NhZ2UodGhpcy5fdmFsaWRhdG9yc1twcm9wZXJ0eU5hbWVdIHx8IFtdLCB2YWx1ZSk7XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLnNhdmUgPSBmdW5jdGlvbiBmbihvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMSAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcztcbiAgY29uc3Qgc2NoZW1hID0gcHJvcGVydGllcy5zY2hlbWE7XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIGlmICh0eXBlb2Ygc2NoZW1hLmJlZm9yZV9zYXZlID09PSAnZnVuY3Rpb24nICYmIHNjaGVtYS5iZWZvcmVfc2F2ZSh0aGlzLCBvcHRpb25zKSA9PT0gZmFsc2UpIHtcbiAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5iZWZvcmUuZXJyb3InKSwgY2FsbGJhY2spO1xuICAgIHJldHVybiB7fTtcbiAgfVxuXG4gIGNvbnN0IHtcbiAgICBpZGVudGlmaWVycyxcbiAgICB2YWx1ZXMsXG4gICAgcXVlcnlQYXJhbXMsXG4gICAgZXJyb3JIYXBwZW5lZCxcbiAgfSA9IHBhcnNlci5nZXRfc2F2ZV92YWx1ZV9leHByZXNzaW9uKHRoaXMsIHNjaGVtYSwgY2FsbGJhY2spO1xuXG4gIGlmIChlcnJvckhhcHBlbmVkKSByZXR1cm4ge307XG5cbiAgbGV0IHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgJ0lOU0VSVCBJTlRPIFwiJXNcIiAoICVzICkgVkFMVUVTICggJXMgKScsXG4gICAgcHJvcGVydGllcy50YWJsZV9uYW1lLFxuICAgIGlkZW50aWZpZXJzLmpvaW4oJyAsICcpLFxuICAgIHZhbHVlcy5qb2luKCcgLCAnKSxcbiAgKTtcblxuICBpZiAob3B0aW9ucy5pZl9ub3RfZXhpc3QpIHF1ZXJ5ICs9ICcgSUYgTk9UIEVYSVNUUyc7XG4gIGlmIChvcHRpb25zLnR0bCkgcXVlcnkgKz0gdXRpbC5mb3JtYXQoJyBVU0lORyBUVEwgJXMnLCBvcHRpb25zLnR0bCk7XG5cbiAgcXVlcnkgKz0gJzsnO1xuXG4gIGlmIChvcHRpb25zLnJldHVybl9xdWVyeSkge1xuICAgIGNvbnN0IHJldHVybk9iaiA9IHtcbiAgICAgIHF1ZXJ5LFxuICAgICAgcGFyYW1zOiBxdWVyeVBhcmFtcyxcbiAgICAgIGFmdGVyX2hvb2s6ICgpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfc2F2ZSA9PT0gJ2Z1bmN0aW9uJyAmJiBzY2hlbWEuYWZ0ZXJfc2F2ZSh0aGlzLCBvcHRpb25zKSA9PT0gZmFsc2UpIHtcbiAgICAgICAgICByZXR1cm4gYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5hZnRlci5lcnJvcicpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICB9O1xuICAgIHJldHVybiByZXR1cm5PYmo7XG4gIH1cblxuICBjb25zdCBxdWVyeU9wdGlvbnMgPSBub3JtYWxpemVyLm5vcm1hbGl6ZV9xdWVyeV9vcHRpb24ob3B0aW9ucyk7XG5cbiAgdGhpcy5jb25zdHJ1Y3Rvci5fZXhlY3V0ZV90YWJsZV9xdWVyeShxdWVyeSwgcXVlcnlQYXJhbXMsIHF1ZXJ5T3B0aW9ucywgKGVyciwgcmVzdWx0KSA9PiB7XG4gICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5zYXZlLmRiZXJyb3InLCBlcnIpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaWYgKCFvcHRpb25zLmlmX25vdF9leGlzdCB8fCAocmVzdWx0LnJvd3MgJiYgcmVzdWx0LnJvd3NbMF0gJiYgcmVzdWx0LnJvd3NbMF1bJ1thcHBsaWVkXSddKSkge1xuICAgICAgICB0aGlzLl9tb2RpZmllZCA9IHt9O1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfc2F2ZSA9PT0gJ2Z1bmN0aW9uJyAmJiBzY2hlbWEuYWZ0ZXJfc2F2ZSh0aGlzLCBvcHRpb25zKSA9PT0gZmFsc2UpIHtcbiAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5hZnRlci5lcnJvcicpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0KTtcbiAgICB9IGVsc2UgaWYgKGVycikge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuZGJlcnJvcicsIGVycikpO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHNjaGVtYS5hZnRlcl9zYXZlID09PSAnZnVuY3Rpb24nICYmIHNjaGVtYS5hZnRlcl9zYXZlKHRoaXMsIG9wdGlvbnMpID09PSBmYWxzZSkge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuYWZ0ZXIuZXJyb3InKSk7XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4ge307XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLmRlbGV0ZSA9IGZ1bmN0aW9uIGYob3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDEgJiYgdHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3Qgc2NoZW1hID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcy5zY2hlbWE7XG4gIGNvbnN0IGRlbGV0ZVF1ZXJ5ID0ge307XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBzY2hlbWEua2V5Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgZmllbGRLZXkgPSBzY2hlbWEua2V5W2ldO1xuICAgIGlmIChfLmlzQXJyYXkoZmllbGRLZXkpKSB7XG4gICAgICBmb3IgKGxldCBqID0gMDsgaiA8IGZpZWxkS2V5Lmxlbmd0aDsgaisrKSB7XG4gICAgICAgIGRlbGV0ZVF1ZXJ5W2ZpZWxkS2V5W2pdXSA9IHRoaXNbZmllbGRLZXlbal1dO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBkZWxldGVRdWVyeVtmaWVsZEtleV0gPSB0aGlzW2ZpZWxkS2V5XTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdGhpcy5jb25zdHJ1Y3Rvci5kZWxldGUoZGVsZXRlUXVlcnksIG9wdGlvbnMsIGNhbGxiYWNrKTtcbn07XG5cbkJhc2VNb2RlbC5wcm90b3R5cGUudG9KU09OID0gZnVuY3Rpb24gdG9KU09OKCkge1xuICBjb25zdCBvYmplY3QgPSB7fTtcbiAgY29uc3Qgc2NoZW1hID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcy5zY2hlbWE7XG5cbiAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaCgoZmllbGQpID0+IHtcbiAgICBvYmplY3RbZmllbGRdID0gdGhpc1tmaWVsZF07XG4gIH0pO1xuXG4gIHJldHVybiBvYmplY3Q7XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLmlzTW9kaWZpZWQgPSBmdW5jdGlvbiBpc01vZGlmaWVkKHByb3BOYW1lKSB7XG4gIGlmIChwcm9wTmFtZSkge1xuICAgIHJldHVybiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwodGhpcy5fbW9kaWZpZWQsIHByb3BOYW1lKTtcbiAgfVxuICByZXR1cm4gT2JqZWN0LmtleXModGhpcy5fbW9kaWZpZWQpLmxlbmd0aCAhPT0gMDtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gQmFzZU1vZGVsO1xuIl19