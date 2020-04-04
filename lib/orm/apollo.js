'use strict';

var Promise = require('bluebird');
var util = require('util');
var _ = require('lodash');

var elasticsearch = void 0;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, import/no-unresolved
  elasticsearch = require('elasticsearch');
} catch (e) {
  elasticsearch = null;
}

var gremlin = void 0;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, import/no-unresolved
  gremlin = require('gremlin');
} catch (e) {
  gremlin = null;
}

var dseDriver = void 0;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, import/no-unresolved
  dseDriver = require('dse-driver');
} catch (e) {
  dseDriver = null;
}

var cql = Promise.promisifyAll(dseDriver || require('cassandra-driver'));

var BaseModel = require('./base_model');
var schemer = require('../validators/schema');
var normalizer = require('../utils/normalizer');
var buildError = require('./apollo_error.js');

var KeyspaceBuilder = require('../builders/keyspace');
var UdtBuilder = require('../builders/udt');
var UdfBuilder = require('../builders/udf');
var UdaBuilder = require('../builders/uda');
var ElassandraBuilder = require('../builders/elassandra');
var JanusGraphBuilder = require('../builders/janusgraph');

var DEFAULT_REPLICATION_FACTOR = 1;

var noop = function noop() {};

var Apollo = function f(connection, options) {
  if (!connection) {
    throw buildError('model.validator.invalidconfig', 'Cassandra connection configuration undefined');
  }

  options = options || {};

  if (!options.defaultReplicationStrategy) {
    options.defaultReplicationStrategy = {
      class: 'SimpleStrategy',
      replication_factor: DEFAULT_REPLICATION_FACTOR
    };
  }

  this._options = options;
  this._models = {};
  this._keyspace = connection.keyspace;
  this._connection = connection;
  this._client = null;
  this._esclient = null;
  this._gremlin_client = null;
};

Apollo.prototype = {

  _generate_model(properties) {
    var Model = function f() {
      for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }

      BaseModel.apply(this, Array.prototype.slice.call(args));
    };

    util.inherits(Model, BaseModel);

    Object.keys(BaseModel).forEach(function (key) {
      Model[key] = BaseModel[key];
    });

    Model._set_properties(properties);

    return Model;
  },

  create_es_client() {
    if (!elasticsearch) {
      throw new Error('Configured to use elassandra, but elasticsearch module was not found, try npm install elasticsearch');
    }

    var contactPoints = this._connection.contactPoints;
    var defaultHosts = [];
    contactPoints.forEach(function (host) {
      defaultHosts.push({ host });
    });

    var esClientConfig = _.defaults(this._connection.elasticsearch, {
      hosts: defaultHosts,
      sniffOnStart: true
    });
    this._esclient = new elasticsearch.Client(esClientConfig);
    return this._esclient;
  },

  _assert_es_index(callback) {
    var esClient = this.create_es_client();
    var indexName = this._keyspace;

    var elassandraBuilder = new ElassandraBuilder(esClient);
    elassandraBuilder.assert_index(indexName, indexName, callback);
  },

  create_gremlin_client() {
    if (!gremlin) {
      throw new Error('Configured to use janus graph server, but gremlin module was not found, try npm install gremlin');
    }

    var contactPoints = this._connection.contactPoints;
    var defaultHosts = [];
    contactPoints.forEach(function (host) {
      defaultHosts.push({ host });
    });

    var gremlinConfig = _.defaults(this._connection.gremlin, {
      host: defaultHosts[0],
      port: 8182,
      options: {}
    });
    this._gremlin_client = gremlin.createClient(gremlinConfig.port, gremlinConfig.host, gremlinConfig.options);
    return this._gremlin_client;
  },

  _assert_gremlin_graph(callback) {
    var gremlinClient = this.create_gremlin_client();
    var keyspaceName = this._keyspace;
    var graphName = `${keyspaceName}_graph`;

    var graphBuilder = new JanusGraphBuilder(gremlinClient);
    graphBuilder.assert_graph(graphName, callback);
  },

  get_system_client() {
    var connection = _.cloneDeep(this._connection);
    delete connection.keyspace;

    return new cql.Client(connection);
  },

  get_keyspace_name() {
    return this._keyspace;
  },

  _assert_keyspace(callback) {
    var client = this.get_system_client();
    var keyspaceName = this._keyspace;
    var options = this._options;

    var keyspaceBuilder = new KeyspaceBuilder(client);

    keyspaceBuilder.get_keyspace(keyspaceName, function (err, keyspaceObject) {
      if (err) {
        callback(err);
        return;
      }

      if (!keyspaceObject) {
        keyspaceBuilder.create_keyspace(keyspaceName, options.defaultReplicationStrategy, callback);
        return;
      }

      var dbReplication = normalizer.normalize_replication_option(keyspaceObject.replication);
      var ormReplication = normalizer.normalize_replication_option(options.defaultReplicationStrategy);

      if (!_.isEqual(dbReplication, ormReplication)) {
        keyspaceBuilder.alter_keyspace(keyspaceName, options.defaultReplicationStrategy, callback);
        return;
      }

      client.shutdown(function () {
        callback();
      });
    });
  },

  _assert_user_defined_types(callback) {
    var client = this._define_connection;
    var options = this._options;
    var keyspace = this._keyspace;

    if (!options.udts) {
      callback();
      return;
    }

    var udtBuilder = new UdtBuilder(client);

    Promise.mapSeries(Object.keys(options.udts), function (udtKey) {
      return new Promise(function (resolve, reject) {
        var udtCallback = function udtCallback(err) {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        };
        udtBuilder.get_udt(udtKey, keyspace, function (err, udtObject) {
          if (err) {
            udtCallback(err);
            return;
          }

          if (!udtObject) {
            udtBuilder.create_udt(udtKey, options.udts[udtKey], udtCallback);
            return;
          }

          var udtKeys = Object.keys(options.udts[udtKey]);
          var udtValues = _.map(_.values(options.udts[udtKey]), normalizer.normalize_user_defined_type);
          var fieldNames = udtObject.field_names;
          var fieldTypes = _.map(udtObject.field_types, normalizer.normalize_user_defined_type);

          if (_.difference(udtKeys, fieldNames).length === 0 && _.difference(udtValues, fieldTypes).length === 0) {
            udtCallback();
            return;
          }

          throw new Error(util.format('User defined type "%s" already exists but does not match the udt definition. ' + 'Consider altering or droping the type.', udtKey));
        });
      });
    }).then(function () {
      callback();
    }).catch(function (err) {
      callback(err);
    });
  },

  _assert_user_defined_functions(callback) {
    var client = this._define_connection;
    var options = this._options;
    var keyspace = this._keyspace;

    if (!options.udfs) {
      callback();
      return;
    }

    var udfBuilder = new UdfBuilder(client);

    Promise.mapSeries(Object.keys(options.udfs), function (udfKey) {
      return new Promise(function (resolve, reject) {
        var udfCallback = function udfCallback(err) {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        };

        udfBuilder.validate_definition(udfKey, options.udfs[udfKey]);

        udfBuilder.get_udf(udfKey, keyspace, function (err, udfObject) {
          if (err) {
            udfCallback(err);
            return;
          }

          if (!udfObject) {
            udfBuilder.create_udf(udfKey, options.udfs[udfKey], udfCallback);
            return;
          }

          var udfLanguage = options.udfs[udfKey].language;
          var resultLanguage = udfObject.language;

          var udfCode = options.udfs[udfKey].code;
          var resultCode = udfObject.body;

          var udfReturnType = normalizer.normalize_user_defined_type(options.udfs[udfKey].returnType);
          var resultReturnType = normalizer.normalize_user_defined_type(udfObject.return_type);

          var udfInputs = options.udfs[udfKey].inputs ? options.udfs[udfKey].inputs : {};
          var udfInputKeys = Object.keys(udfInputs);
          var udfInputValues = _.map(_.values(udfInputs), normalizer.normalize_user_defined_type);
          var resultArgumentNames = udfObject.argument_names;
          var resultArgumentTypes = _.map(udfObject.argument_types, normalizer.normalize_user_defined_type);

          if (udfLanguage === resultLanguage && udfCode === resultCode && udfReturnType === resultReturnType && _.isEqual(udfInputKeys, resultArgumentNames) && _.isEqual(udfInputValues, resultArgumentTypes)) {
            udfCallback();
            return;
          }

          udfBuilder.create_udf(udfKey, options.udfs[udfKey], udfCallback);
        });
      });
    }).then(function () {
      callback();
    }).catch(function (err) {
      callback(err);
    });
  },

  _assert_user_defined_aggregates(callback) {
    var client = this._define_connection;
    var options = this._options;
    var keyspace = this._keyspace;

    if (!options.udas) {
      callback();
      return;
    }

    var udaBuilder = new UdaBuilder(client);

    Promise.mapSeries(Object.keys(options.udas), function (udaKey) {
      return new Promise(function (resolve, reject) {
        var udaCallback = function udaCallback(err) {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        };

        udaBuilder.validate_definition(udaKey, options.udas[udaKey]);

        if (!options.udas[udaKey].initcond) {
          options.udas[udaKey].initcond = null;
        }

        udaBuilder.get_uda(udaKey, keyspace, function (err, udaObjects) {
          if (err) {
            udaCallback(err);
            return;
          }

          if (!udaObjects) {
            udaBuilder.create_uda(udaKey, options.udas[udaKey], udaCallback);
            return;
          }

          var inputTypes = _.map(options.udas[udaKey].input_types, normalizer.normalize_user_defined_type);
          var sfunc = options.udas[udaKey].sfunc.toLowerCase();
          var stype = normalizer.normalize_user_defined_type(options.udas[udaKey].stype);
          var finalfunc = options.udas[udaKey].finalfunc ? options.udas[udaKey].finalfunc.toLowerCase() : null;
          var initcond = options.udas[udaKey].initcond ? options.udas[udaKey].initcond.replace(/[\s]/g, '') : null;

          for (var i = 0; i < udaObjects.length; i++) {
            var resultArgumentTypes = _.map(udaObjects[i].argument_types, normalizer.normalize_user_defined_type);

            var resultStateFunc = udaObjects[i].state_func;
            var resultStateType = normalizer.normalize_user_defined_type(udaObjects[i].state_type);
            var resultFinalFunc = udaObjects[i].final_func;
            var resultInitcond = udaObjects[i].initcond ? udaObjects[i].initcond.replace(/[\s]/g, '') : null;

            if (sfunc === resultStateFunc && stype === resultStateType && finalfunc === resultFinalFunc && initcond === resultInitcond && _.isEqual(inputTypes, resultArgumentTypes)) {
              udaCallback();
              return;
            }
          }
          udaBuilder.create_uda(udaKey, options.udas[udaKey], udaCallback);
        });
      });
    }).then(function () {
      callback();
    }).catch(function (err) {
      callback(err);
    });
  },

  _set_client(client) {
    var _this = this;

    var defineConnectionOptions = _.cloneDeep(this._connection);

    this._client = client;
    this._define_connection = new cql.Client(defineConnectionOptions);

    // Reset connections on all models
    Object.keys(this._models).forEach(function (i) {
      if (_this._models[i]._properties.cql && typeof _this._models[i]._properties.cql.close === "function") {
        _this._models[i]._properties.cql.shutdown(function () {});
      }
      _this._models[i]._properties.cql = _this._client;

      if (_this._models[i]._properties.define_connection && typeof _this._models[i]._properties.define_connection.close === "function") {
        _this._models[i]._properties.define_connection.shutdown(function () {});
      }
      _this._models[i]._properties.define_connection = _this._define_connection;
    });
  },

  init(callback) {
    var _this2 = this;

    var onUserDefinedAggregates = function onUserDefinedAggregates(err) {
      if (err) {
        callback(err);
        return;
      }

      var managementTasks = [];
      if (_this2._keyspace && _this2._options.manageESIndex) {
        _this2.assertESIndexAsync = Promise.promisify(_this2._assert_es_index);
        managementTasks.push(_this2.assertESIndexAsync());
      }
      if (_this2._keyspace && _this2._options.manageGraphs) {
        _this2.assertGremlinGraphAsync = Promise.promisify(_this2._assert_gremlin_graph);
        managementTasks.push(_this2.assertGremlinGraphAsync());
      }
      Promise.all(managementTasks).then(function () {
        callback(null, _this2);
      }).catch(function (err1) {
        callback(err1);
      });
    };

    var onUserDefinedFunctions = function f(err) {
      if (err) {
        callback(err);
        return;
      }
      try {
        this._assert_user_defined_aggregates(onUserDefinedAggregates.bind(this));
      } catch (e) {
        throw buildError('model.validator.invaliduda', e.message);
      }
    };

    var onUserDefinedTypes = function f(err) {
      if (err) {
        callback(err);
        return;
      }
      try {
        this._assert_user_defined_functions(onUserDefinedFunctions.bind(this));
      } catch (e) {
        throw buildError('model.validator.invalidudf', e.message);
      }
    };

    var onKeyspace = function f(err) {
      if (err) {
        callback(err);
        return;
      }
      this._set_client(new cql.Client(this._connection));
      try {
        this._assert_user_defined_types(onUserDefinedTypes.bind(this));
      } catch (e) {
        throw buildError('model.validator.invalidudt', e.message);
      }
    };

    if (this._keyspace && this._options.createKeyspace !== false) {
      this._assert_keyspace(onKeyspace.bind(this));
    } else {
      onKeyspace.call(this);
    }
  },

  addModel(modelName, modelSchema) {
    if (!modelName || typeof modelName !== 'string') {
      throw buildError('model.validator.invalidschema', 'Model name must be a valid string');
    }

    try {
      schemer.validate_model_schema(modelSchema);
    } catch (e) {
      throw buildError('model.validator.invalidschema', e.message);
    }

    if (modelSchema.options && modelSchema.options.timestamps) {
      var timestampOptions = {
        createdAt: modelSchema.options.timestamps.createdAt || 'createdAt',
        updatedAt: modelSchema.options.timestamps.updatedAt || 'updatedAt'
      };
      modelSchema.options.timestamps = timestampOptions;

      modelSchema.fields[modelSchema.options.timestamps.createdAt] = {
        type: 'timestamp',
        default: {
          $db_function: 'toTimestamp(now())'
        }
      };
      modelSchema.fields[modelSchema.options.timestamps.updatedAt] = {
        type: 'timestamp',
        default: {
          $db_function: 'toTimestamp(now())'
        }
      };
    }

    if (modelSchema.options && modelSchema.options.versions) {
      var versionOptions = {
        key: modelSchema.options.versions.key || '__v'
      };
      modelSchema.options.versions = versionOptions;

      modelSchema.fields[modelSchema.options.versions.key] = {
        type: 'timeuuid',
        default: {
          $db_function: 'now()'
        }
      };
    }

    var baseProperties = {
      name: modelName,
      schema: modelSchema,
      keyspace: this._keyspace,
      connection_options: this._connection,
      define_connection: this._define_connection,
      cql: this._client,
      esclient: this._esclient,
      gremlin_client: this._gremlin_client,
      get_constructor: this.getModel.bind(this, modelName),
      init: this.init.bind(this),
      dropTableOnSchemaChange: this._options.dropTableOnSchemaChange,
      createTable: this._options.createTable,
      migration: this._options.migration,
      disableTTYConfirmation: this._options.disableTTYConfirmation
    };

    this._models[modelName] = this._generate_model(baseProperties);
    return this._models[modelName];
  },

  getModel(modelName) {
    return this._models[modelName] || null;
  },

  close(callback) {
    callback = callback || noop;

    if (this.orm._esclient) {
      this.orm._esclient.close();
    }

    if (this.orm._gremlin_client && this.orm._gremlin_client.connection && this.orm._gremlin_client.connection.ws) {
      this.orm._gremlin_client.connection.ws.close();
    }

    var clientsToShutdown = [];
    if (this.orm._client) {
      clientsToShutdown.push(this.orm._client.shutdown());
    }
    if (this.orm._define_connection) {
      clientsToShutdown.push(this.orm._define_connection.shutdown());
    }

    Promise.all(clientsToShutdown).then(function () {
      callback();
    }).catch(function (err) {
      callback(err);
    });
  }
};

module.exports = Apollo;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9vcm0vYXBvbGxvLmpzIl0sIm5hbWVzIjpbIlByb21pc2UiLCJyZXF1aXJlIiwidXRpbCIsIl8iLCJlbGFzdGljc2VhcmNoIiwiZSIsImdyZW1saW4iLCJkc2VEcml2ZXIiLCJjcWwiLCJwcm9taXNpZnlBbGwiLCJCYXNlTW9kZWwiLCJzY2hlbWVyIiwibm9ybWFsaXplciIsImJ1aWxkRXJyb3IiLCJLZXlzcGFjZUJ1aWxkZXIiLCJVZHRCdWlsZGVyIiwiVWRmQnVpbGRlciIsIlVkYUJ1aWxkZXIiLCJFbGFzc2FuZHJhQnVpbGRlciIsIkphbnVzR3JhcGhCdWlsZGVyIiwiREVGQVVMVF9SRVBMSUNBVElPTl9GQUNUT1IiLCJub29wIiwiQXBvbGxvIiwiZiIsImNvbm5lY3Rpb24iLCJvcHRpb25zIiwiZGVmYXVsdFJlcGxpY2F0aW9uU3RyYXRlZ3kiLCJjbGFzcyIsInJlcGxpY2F0aW9uX2ZhY3RvciIsIl9vcHRpb25zIiwiX21vZGVscyIsIl9rZXlzcGFjZSIsImtleXNwYWNlIiwiX2Nvbm5lY3Rpb24iLCJfY2xpZW50IiwiX2VzY2xpZW50IiwiX2dyZW1saW5fY2xpZW50IiwicHJvdG90eXBlIiwiX2dlbmVyYXRlX21vZGVsIiwicHJvcGVydGllcyIsIk1vZGVsIiwiYXJncyIsImFwcGx5IiwiQXJyYXkiLCJzbGljZSIsImNhbGwiLCJpbmhlcml0cyIsIk9iamVjdCIsImtleXMiLCJmb3JFYWNoIiwia2V5IiwiX3NldF9wcm9wZXJ0aWVzIiwiY3JlYXRlX2VzX2NsaWVudCIsIkVycm9yIiwiY29udGFjdFBvaW50cyIsImRlZmF1bHRIb3N0cyIsImhvc3QiLCJwdXNoIiwiZXNDbGllbnRDb25maWciLCJkZWZhdWx0cyIsImhvc3RzIiwic25pZmZPblN0YXJ0IiwiQ2xpZW50IiwiX2Fzc2VydF9lc19pbmRleCIsImNhbGxiYWNrIiwiZXNDbGllbnQiLCJpbmRleE5hbWUiLCJlbGFzc2FuZHJhQnVpbGRlciIsImFzc2VydF9pbmRleCIsImNyZWF0ZV9ncmVtbGluX2NsaWVudCIsImdyZW1saW5Db25maWciLCJwb3J0IiwiY3JlYXRlQ2xpZW50IiwiX2Fzc2VydF9ncmVtbGluX2dyYXBoIiwiZ3JlbWxpbkNsaWVudCIsImtleXNwYWNlTmFtZSIsImdyYXBoTmFtZSIsImdyYXBoQnVpbGRlciIsImFzc2VydF9ncmFwaCIsImdldF9zeXN0ZW1fY2xpZW50IiwiY2xvbmVEZWVwIiwiZ2V0X2tleXNwYWNlX25hbWUiLCJfYXNzZXJ0X2tleXNwYWNlIiwiY2xpZW50Iiwia2V5c3BhY2VCdWlsZGVyIiwiZ2V0X2tleXNwYWNlIiwiZXJyIiwia2V5c3BhY2VPYmplY3QiLCJjcmVhdGVfa2V5c3BhY2UiLCJkYlJlcGxpY2F0aW9uIiwibm9ybWFsaXplX3JlcGxpY2F0aW9uX29wdGlvbiIsInJlcGxpY2F0aW9uIiwib3JtUmVwbGljYXRpb24iLCJpc0VxdWFsIiwiYWx0ZXJfa2V5c3BhY2UiLCJzaHV0ZG93biIsIl9hc3NlcnRfdXNlcl9kZWZpbmVkX3R5cGVzIiwiX2RlZmluZV9jb25uZWN0aW9uIiwidWR0cyIsInVkdEJ1aWxkZXIiLCJtYXBTZXJpZXMiLCJ1ZHRLZXkiLCJyZXNvbHZlIiwicmVqZWN0IiwidWR0Q2FsbGJhY2siLCJnZXRfdWR0IiwidWR0T2JqZWN0IiwiY3JlYXRlX3VkdCIsInVkdEtleXMiLCJ1ZHRWYWx1ZXMiLCJtYXAiLCJ2YWx1ZXMiLCJub3JtYWxpemVfdXNlcl9kZWZpbmVkX3R5cGUiLCJmaWVsZE5hbWVzIiwiZmllbGRfbmFtZXMiLCJmaWVsZFR5cGVzIiwiZmllbGRfdHlwZXMiLCJkaWZmZXJlbmNlIiwibGVuZ3RoIiwiZm9ybWF0IiwidGhlbiIsImNhdGNoIiwiX2Fzc2VydF91c2VyX2RlZmluZWRfZnVuY3Rpb25zIiwidWRmcyIsInVkZkJ1aWxkZXIiLCJ1ZGZLZXkiLCJ1ZGZDYWxsYmFjayIsInZhbGlkYXRlX2RlZmluaXRpb24iLCJnZXRfdWRmIiwidWRmT2JqZWN0IiwiY3JlYXRlX3VkZiIsInVkZkxhbmd1YWdlIiwibGFuZ3VhZ2UiLCJyZXN1bHRMYW5ndWFnZSIsInVkZkNvZGUiLCJjb2RlIiwicmVzdWx0Q29kZSIsImJvZHkiLCJ1ZGZSZXR1cm5UeXBlIiwicmV0dXJuVHlwZSIsInJlc3VsdFJldHVyblR5cGUiLCJyZXR1cm5fdHlwZSIsInVkZklucHV0cyIsImlucHV0cyIsInVkZklucHV0S2V5cyIsInVkZklucHV0VmFsdWVzIiwicmVzdWx0QXJndW1lbnROYW1lcyIsImFyZ3VtZW50X25hbWVzIiwicmVzdWx0QXJndW1lbnRUeXBlcyIsImFyZ3VtZW50X3R5cGVzIiwiX2Fzc2VydF91c2VyX2RlZmluZWRfYWdncmVnYXRlcyIsInVkYXMiLCJ1ZGFCdWlsZGVyIiwidWRhS2V5IiwidWRhQ2FsbGJhY2siLCJpbml0Y29uZCIsImdldF91ZGEiLCJ1ZGFPYmplY3RzIiwiY3JlYXRlX3VkYSIsImlucHV0VHlwZXMiLCJpbnB1dF90eXBlcyIsInNmdW5jIiwidG9Mb3dlckNhc2UiLCJzdHlwZSIsImZpbmFsZnVuYyIsInJlcGxhY2UiLCJpIiwicmVzdWx0U3RhdGVGdW5jIiwic3RhdGVfZnVuYyIsInJlc3VsdFN0YXRlVHlwZSIsInN0YXRlX3R5cGUiLCJyZXN1bHRGaW5hbEZ1bmMiLCJmaW5hbF9mdW5jIiwicmVzdWx0SW5pdGNvbmQiLCJfc2V0X2NsaWVudCIsImRlZmluZUNvbm5lY3Rpb25PcHRpb25zIiwiX3Byb3BlcnRpZXMiLCJjbG9zZSIsImRlZmluZV9jb25uZWN0aW9uIiwiaW5pdCIsIm9uVXNlckRlZmluZWRBZ2dyZWdhdGVzIiwibWFuYWdlbWVudFRhc2tzIiwibWFuYWdlRVNJbmRleCIsImFzc2VydEVTSW5kZXhBc3luYyIsInByb21pc2lmeSIsIm1hbmFnZUdyYXBocyIsImFzc2VydEdyZW1saW5HcmFwaEFzeW5jIiwiYWxsIiwiZXJyMSIsIm9uVXNlckRlZmluZWRGdW5jdGlvbnMiLCJiaW5kIiwibWVzc2FnZSIsIm9uVXNlckRlZmluZWRUeXBlcyIsIm9uS2V5c3BhY2UiLCJjcmVhdGVLZXlzcGFjZSIsImFkZE1vZGVsIiwibW9kZWxOYW1lIiwibW9kZWxTY2hlbWEiLCJ2YWxpZGF0ZV9tb2RlbF9zY2hlbWEiLCJ0aW1lc3RhbXBzIiwidGltZXN0YW1wT3B0aW9ucyIsImNyZWF0ZWRBdCIsInVwZGF0ZWRBdCIsImZpZWxkcyIsInR5cGUiLCJkZWZhdWx0IiwiJGRiX2Z1bmN0aW9uIiwidmVyc2lvbnMiLCJ2ZXJzaW9uT3B0aW9ucyIsImJhc2VQcm9wZXJ0aWVzIiwibmFtZSIsInNjaGVtYSIsImNvbm5lY3Rpb25fb3B0aW9ucyIsImVzY2xpZW50IiwiZ3JlbWxpbl9jbGllbnQiLCJnZXRfY29uc3RydWN0b3IiLCJnZXRNb2RlbCIsImRyb3BUYWJsZU9uU2NoZW1hQ2hhbmdlIiwiY3JlYXRlVGFibGUiLCJtaWdyYXRpb24iLCJkaXNhYmxlVFRZQ29uZmlybWF0aW9uIiwib3JtIiwid3MiLCJjbGllbnRzVG9TaHV0ZG93biIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7O0FBQUEsSUFBTUEsVUFBVUMsUUFBUSxVQUFSLENBQWhCO0FBQ0EsSUFBTUMsT0FBT0QsUUFBUSxNQUFSLENBQWI7QUFDQSxJQUFNRSxJQUFJRixRQUFRLFFBQVIsQ0FBVjs7QUFFQSxJQUFJRyxzQkFBSjtBQUNBLElBQUk7QUFDRjtBQUNBQSxrQkFBZ0JILFFBQVEsZUFBUixDQUFoQjtBQUNELENBSEQsQ0FHRSxPQUFPSSxDQUFQLEVBQVU7QUFDVkQsa0JBQWdCLElBQWhCO0FBQ0Q7O0FBRUQsSUFBSUUsZ0JBQUo7QUFDQSxJQUFJO0FBQ0Y7QUFDQUEsWUFBVUwsUUFBUSxTQUFSLENBQVY7QUFDRCxDQUhELENBR0UsT0FBT0ksQ0FBUCxFQUFVO0FBQ1ZDLFlBQVUsSUFBVjtBQUNEOztBQUVELElBQUlDLGtCQUFKO0FBQ0EsSUFBSTtBQUNGO0FBQ0FBLGNBQVlOLFFBQVEsWUFBUixDQUFaO0FBQ0QsQ0FIRCxDQUdFLE9BQU9JLENBQVAsRUFBVTtBQUNWRSxjQUFZLElBQVo7QUFDRDs7QUFFRCxJQUFNQyxNQUFNUixR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S0FBS29LLEdBQUwsQ0FBUzNMLE9BQVQsQ0FBaUI2RCxRQUFqQixFQUF2QjtBQUNEO0FBQ0QsUUFBSSxLQUFLOEgsR0FBTCxDQUFTNUgsa0JBQWIsRUFBaUM7QUFDL0I4SCx3QkFBa0J0SyxJQUFsQixDQUF1QixLQUFLb0ssR0FBTCxDQUFTNUgsa0JBQVQsQ0FBNEJGLFFBQTVCLEVBQXZCO0FBQ0Q7O0FBRUQvRixZQUFRMkwsR0FBUixDQUFZb0MsaUJBQVosRUFDR3ZHLElBREgsQ0FDUSxZQUFNO0FBQ1Z4RDtBQUNELEtBSEgsRUFJR3lELEtBSkgsQ0FJUyxVQUFDbkMsR0FBRCxFQUFTO0FBQ2R0QixlQUFTc0IsR0FBVDtBQUNELEtBTkg7QUFPRDtBQXBmZ0IsQ0FBbkI7O0FBdWZBMEksT0FBT0MsT0FBUCxHQUFpQjNNLE1BQWpCIiwiZmlsZSI6ImFwb2xsby5qcyIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IFByb21pc2UgPSByZXF1aXJlKCdibHVlYmlyZCcpO1xuY29uc3QgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcbmNvbnN0IF8gPSByZXF1aXJlKCdsb2Rhc2gnKTtcblxubGV0IGVsYXN0aWNzZWFyY2g7XG50cnkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgaW1wb3J0L25vLWV4dHJhbmVvdXMtZGVwZW5kZW5jaWVzLCBpbXBvcnQvbm8tdW5yZXNvbHZlZFxuICBlbGFzdGljc2VhcmNoID0gcmVxdWlyZSgnZWxhc3RpY3NlYXJjaCcpO1xufSBjYXRjaCAoZSkge1xuICBlbGFzdGljc2VhcmNoID0gbnVsbDtcbn1cblxubGV0IGdyZW1saW47XG50cnkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgaW1wb3J0L25vLWV4dHJhbmVvdXMtZGVwZW5kZW5jaWVzLCBpbXBvcnQvbm8tdW5yZXNvbHZlZFxuICBncmVtbGluID0gcmVxdWlyZSgnZ3JlbWxpbicpO1xufSBjYXRjaCAoZSkge1xuICBncmVtbGluID0gbnVsbDtcbn1cblxubGV0IGRzZURyaXZlcjtcbnRyeSB7XG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBpbXBvcnQvbm8tZXh0cmFuZW91cy1kZXBlbmRlbmNpZXMsIGltcG9ydC9uby11bnJlc29sdmVkXG4gIGRzZURyaXZlciA9IHJlcXVpcmUoJ2RzZS1kcml2ZXInKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZHNlRHJpdmVyID0gbnVsbDtcbn1cblxuY29uc3QgY3FsID0gUHJvbWlzZS5wcm9taXNpZnlBbGwoZHNlRHJpdmVyIHx8IHJlcXVpcmUoJ2Nhc3NhbmRyYS1kcml2ZXInKSk7XG5cbmNvbnN0IEJhc2VNb2RlbCA9IHJlcXVpcmUoJy4vYmFzZV9tb2RlbCcpO1xuY29uc3Qgc2NoZW1lciA9IHJlcXVpcmUoJy4uL3ZhbGlkYXRvcnMvc2NoZW1hJyk7XG5jb25zdCBub3JtYWxpemVyID0gcmVxdWlyZSgnLi4vdXRpbHMvbm9ybWFsaXplcicpO1xuY29uc3QgYnVpbGRFcnJvciA9IHJlcXVpcmUoJy4vYXBvbGxvX2Vycm9yLmpzJyk7XG5cbmNvbnN0IEtleXNwYWNlQnVpbGRlciA9IHJlcXVpcmUoJy4uL2J1aWxkZXJzL2tleXNwYWNlJyk7XG5jb25zdCBVZHRCdWlsZGVyID0gcmVxdWlyZSgnLi4vYnVpbGRlcnMvdWR0Jyk7XG5jb25zdCBVZGZCdWlsZGVyID0gcmVxdWlyZSgnLi4vYnVpbGRlcnMvdWRmJyk7XG5jb25zdCBVZGFCdWlsZGVyID0gcmVxdWlyZSgnLi4vYnVpbGRlcnMvdWRhJyk7XG5jb25zdCBFbGFzc2FuZHJhQnVpbGRlciA9IHJlcXVpcmUoJy4uL2J1aWxkZXJzL2VsYXNzYW5kcmEnKTtcbmNvbnN0IEphbnVzR3JhcGhCdWlsZGVyID0gcmVxdWlyZSgnLi4vYnVpbGRlcnMvamFudXNncmFwaCcpO1xuXG5jb25zdCBERUZBVUxUX1JFUExJQ0FUSU9OX0ZBQ1RPUiA9IDE7XG5cbmNvbnN0IG5vb3AgPSAoKSA9PiB7fTtcblxuY29uc3QgQXBvbGxvID0gZnVuY3Rpb24gZihjb25uZWN0aW9uLCBvcHRpb25zKSB7XG4gIGlmICghY29ubmVjdGlvbikge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZGNvbmZpZycsICdDYXNzYW5kcmEgY29ubmVjdGlvbiBjb25maWd1cmF0aW9uIHVuZGVmaW5lZCcpKTtcbiAgfVxuXG4gIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuXG4gIGlmICghb3B0aW9ucy5kZWZhdWx0UmVwbGljYXRpb25TdHJhdGVneSkge1xuICAgIG9wdGlvbnMuZGVmYXVsdFJlcGxpY2F0aW9uU3RyYXRlZ3kgPSB7XG4gICAgICBjbGFzczogJ1NpbXBsZVN0cmF0ZWd5JyxcbiAgICAgIHJlcGxpY2F0aW9uX2ZhY3RvcjogREVGQVVMVF9SRVBMSUNBVElPTl9GQUNUT1IsXG4gICAgfTtcbiAgfVxuXG4gIHRoaXMuX29wdGlvbnMgPSBvcHRpb25zO1xuICB0aGlzLl9tb2RlbHMgPSB7fTtcbiAgdGhpcy5fa2V5c3BhY2UgPSBjb25uZWN0aW9uLmtleXNwYWNlO1xuICB0aGlzLl9jb25uZWN0aW9uID0gY29ubmVjdGlvbjtcbiAgdGhpcy5fY2xpZW50ID0gbnVsbDtcbiAgdGhpcy5fZXNjbGllbnQgPSBudWxsO1xuICB0aGlzLl9ncmVtbGluX2NsaWVudCA9IG51bGw7XG59O1xuXG5BcG9sbG8ucHJvdG90eXBlID0ge1xuXG4gIF9nZW5lcmF0ZV9tb2RlbChwcm9wZXJ0aWVzKSB7XG4gICAgY29uc3QgTW9kZWwgPSBmdW5jdGlvbiBmKC4uLmFyZ3MpIHtcbiAgICAgIEJhc2VNb2RlbC5hcHBseSh0aGlzLCBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmdzKSk7XG4gICAgfTtcblxuICAgIHV0aWwuaW5oZXJpdHMoTW9kZWwsIEJhc2VNb2RlbCk7XG5cbiAgICBPYmplY3Qua2V5cyhCYXNlTW9kZWwpLmZvckVhY2goKGtleSkgPT4ge1xuICAgICAgTW9kZWxba2V5XSA9IEJhc2VNb2RlbFtrZXldO1xuICAgIH0pO1xuXG4gICAgTW9kZWwuX3NldF9wcm9wZXJ0aWVzKHByb3BlcnRpZXMpO1xuXG4gICAgcmV0dXJuIE1vZGVsO1xuICB9LFxuXG4gIGNyZWF0ZV9lc19jbGllbnQoKSB7XG4gICAgaWYgKCFlbGFzdGljc2VhcmNoKSB7XG4gICAgICB0aHJvdyAobmV3IEVycm9yKCdDb25maWd1cmVkIHRvIHVzZSBlbGFzc2FuZHJhLCBidXQgZWxhc3RpY3NlYXJjaCBtb2R1bGUgd2FzIG5vdCBmb3VuZCwgdHJ5IG5wbSBpbnN0YWxsIGVsYXN0aWNzZWFyY2gnKSk7XG4gICAgfVxuXG4gICAgY29uc3QgY29udGFjdFBvaW50cyA9IHRoaXMuX2Nvbm5lY3Rpb24uY29udGFjdFBvaW50cztcbiAgICBjb25zdCBkZWZhdWx0SG9zdHMgPSBbXTtcbiAgICBjb250YWN0UG9pbnRzLmZvckVhY2goKGhvc3QpID0+IHtcbiAgICAgIGRlZmF1bHRIb3N0cy5wdXNoKHsgaG9zdCB9KTtcbiAgICB9KTtcblxuICAgIGNvbnN0IGVzQ2xpZW50Q29uZmlnID0gXy5kZWZhdWx0cyh0aGlzLl9jb25uZWN0aW9uLmVsYXN0aWNzZWFyY2gsIHtcbiAgICAgIGhvc3RzOiBkZWZhdWx0SG9zdHMsXG4gICAgICBzbmlmZk9uU3RhcnQ6IHRydWUsXG4gICAgfSk7XG4gICAgdGhpcy5fZXNjbGllbnQgPSBuZXcgZWxhc3RpY3NlYXJjaC5DbGllbnQoZXNDbGllbnRDb25maWcpO1xuICAgIHJldHVybiB0aGlzLl9lc2NsaWVudDtcbiAgfSxcblxuICBfYXNzZXJ0X2VzX2luZGV4KGNhbGxiYWNrKSB7XG4gICAgY29uc3QgZXNDbGllbnQgPSB0aGlzLmNyZWF0ZV9lc19jbGllbnQoKTtcbiAgICBjb25zdCBpbmRleE5hbWUgPSB0aGlzLl9rZXlzcGFjZTtcblxuICAgIGNvbnN0IGVsYXNzYW5kcmFCdWlsZGVyID0gbmV3IEVsYXNzYW5kcmFCdWlsZGVyKGVzQ2xpZW50KTtcbiAgICBlbGFzc2FuZHJhQnVpbGRlci5hc3NlcnRfaW5kZXgoaW5kZXhOYW1lLCBpbmRleE5hbWUsIGNhbGxiYWNrKTtcbiAgfSxcblxuICBjcmVhdGVfZ3JlbWxpbl9jbGllbnQoKSB7XG4gICAgaWYgKCFncmVtbGluKSB7XG4gICAgICB0aHJvdyAobmV3IEVycm9yKCdDb25maWd1cmVkIHRvIHVzZSBqYW51cyBncmFwaCBzZXJ2ZXIsIGJ1dCBncmVtbGluIG1vZHVsZSB3YXMgbm90IGZvdW5kLCB0cnkgbnBtIGluc3RhbGwgZ3JlbWxpbicpKTtcbiAgICB9XG5cbiAgICBjb25zdCBjb250YWN0UG9pbnRzID0gdGhpcy5fY29ubmVjdGlvbi5jb250YWN0UG9pbnRzO1xuICAgIGNvbnN0IGRlZmF1bHRIb3N0cyA9IFtdO1xuICAgIGNvbnRhY3RQb2ludHMuZm9yRWFjaCgoaG9zdCkgPT4ge1xuICAgICAgZGVmYXVsdEhvc3RzLnB1c2goeyBob3N0IH0pO1xuICAgIH0pO1xuXG4gICAgY29uc3QgZ3JlbWxpbkNvbmZpZyA9IF8uZGVmYXVsdHModGhpcy5fY29ubmVjdGlvbi5ncmVtbGluLCB7XG4gICAgICBob3N0OiBkZWZhdWx0SG9zdHNbMF0sXG4gICAgICBwb3J0OiA4MTgyLFxuICAgICAgb3B0aW9uczoge30sXG4gICAgfSk7XG4gICAgdGhpcy5fZ3JlbWxpbl9jbGllbnQgPSBncmVtbGluLmNyZWF0ZUNsaWVudChncmVtbGluQ29uZmlnLnBvcnQsIGdyZW1saW5Db25maWcuaG9zdCwgZ3JlbWxpbkNvbmZpZy5vcHRpb25zKTtcbiAgICByZXR1cm4gdGhpcy5fZ3JlbWxpbl9jbGllbnQ7XG4gIH0sXG5cbiAgX2Fzc2VydF9ncmVtbGluX2dyYXBoKGNhbGxiYWNrKSB7XG4gICAgY29uc3QgZ3JlbWxpbkNsaWVudCA9IHRoaXMuY3JlYXRlX2dyZW1saW5fY2xpZW50KCk7XG4gICAgY29uc3Qga2V5c3BhY2VOYW1lID0gdGhpcy5fa2V5c3BhY2U7XG4gICAgY29uc3QgZ3JhcGhOYW1lID0gYCR7a2V5c3BhY2VOYW1lfV9ncmFwaGA7XG5cbiAgICBjb25zdCBncmFwaEJ1aWxkZXIgPSBuZXcgSmFudXNHcmFwaEJ1aWxkZXIoZ3JlbWxpbkNsaWVudCk7XG4gICAgZ3JhcGhCdWlsZGVyLmFzc2VydF9ncmFwaChncmFwaE5hbWUsIGNhbGxiYWNrKTtcbiAgfSxcblxuICBnZXRfc3lzdGVtX2NsaWVudCgpIHtcbiAgICBjb25zdCBjb25uZWN0aW9uID0gXy5jbG9uZURlZXAodGhpcy5fY29ubmVjdGlvbik7XG4gICAgZGVsZXRlIGNvbm5lY3Rpb24ua2V5c3BhY2U7XG5cbiAgICByZXR1cm4gbmV3IGNxbC5DbGllbnQoY29ubmVjdGlvbik7XG4gIH0sXG5cbiAgZ2V0X2tleXNwYWNlX25hbWUoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2tleXNwYWNlO1xuICB9LFxuXG4gIF9hc3NlcnRfa2V5c3BhY2UoY2FsbGJhY2spIHtcbiAgICBjb25zdCBjbGllbnQgPSB0aGlzLmdldF9zeXN0ZW1fY2xpZW50KCk7XG4gICAgY29uc3Qga2V5c3BhY2VOYW1lID0gdGhpcy5fa2V5c3BhY2U7XG4gICAgY29uc3Qgb3B0aW9ucyA9IHRoaXMuX29wdGlvbnM7XG5cbiAgICBjb25zdCBrZXlzcGFjZUJ1aWxkZXIgPSBuZXcgS2V5c3BhY2VCdWlsZGVyKGNsaWVudCk7XG5cbiAgICBrZXlzcGFjZUJ1aWxkZXIuZ2V0X2tleXNwYWNlKGtleXNwYWNlTmFtZSwgKGVyciwga2V5c3BhY2VPYmplY3QpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBpZiAoIWtleXNwYWNlT2JqZWN0KSB7XG4gICAgICAgIGtleXNwYWNlQnVpbGRlci5jcmVhdGVfa2V5c3BhY2Uoa2V5c3BhY2VOYW1lLCBvcHRpb25zLmRlZmF1bHRSZXBsaWNhdGlvblN0cmF0ZWd5LCBjYWxsYmFjayk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgZGJSZXBsaWNhdGlvbiA9IG5vcm1hbGl6ZXIubm9ybWFsaXplX3JlcGxpY2F0aW9uX29wdGlvbihrZXlzcGFjZU9iamVjdC5yZXBsaWNhdGlvbik7XG4gICAgICBjb25zdCBvcm1SZXBsaWNhdGlvbiA9IG5vcm1hbGl6ZXIubm9ybWFsaXplX3JlcGxpY2F0aW9uX29wdGlvbihvcHRpb25zLmRlZmF1bHRSZXBsaWNhdGlvblN0cmF0ZWd5KTtcblxuICAgICAgaWYgKCFfLmlzRXF1YWwoZGJSZXBsaWNhdGlvbiwgb3JtUmVwbGljYXRpb24pKSB7XG4gICAgICAgIGtleXNwYWNlQnVpbGRlci5hbHRlcl9rZXlzcGFjZShrZXlzcGFjZU5hbWUsIG9wdGlvbnMuZGVmYXVsdFJlcGxpY2F0aW9uU3RyYXRlZ3ksIGNhbGxiYWNrKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjbGllbnQuc2h1dGRvd24oKCkgPT4ge1xuICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgX2Fzc2VydF91c2VyX2RlZmluZWRfdHlwZXMoY2FsbGJhY2spIHtcbiAgICBjb25zdCBjbGllbnQgPSB0aGlzLl9kZWZpbmVfY29ubmVjdGlvbjtcbiAgICBjb25zdCBvcHRpb25zID0gdGhpcy5fb3B0aW9ucztcbiAgICBjb25zdCBrZXlzcGFjZSA9IHRoaXMuX2tleXNwYWNlO1xuXG4gICAgaWYgKCFvcHRpb25zLnVkdHMpIHtcbiAgICAgIGNhbGxiYWNrKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgdWR0QnVpbGRlciA9IG5ldyBVZHRCdWlsZGVyKGNsaWVudCk7XG5cbiAgICBQcm9taXNlLm1hcFNlcmllcyhPYmplY3Qua2V5cyhvcHRpb25zLnVkdHMpLCAodWR0S2V5KSA9PiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB1ZHRDYWxsYmFjayA9IChlcnIpID0+IHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9O1xuICAgICAgdWR0QnVpbGRlci5nZXRfdWR0KHVkdEtleSwga2V5c3BhY2UsIChlcnIsIHVkdE9iamVjdCkgPT4ge1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgdWR0Q2FsbGJhY2soZXJyKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXVkdE9iamVjdCkge1xuICAgICAgICAgIHVkdEJ1aWxkZXIuY3JlYXRlX3VkdCh1ZHRLZXksIG9wdGlvbnMudWR0c1t1ZHRLZXldLCB1ZHRDYWxsYmFjayk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdWR0S2V5cyA9IE9iamVjdC5rZXlzKG9wdGlvbnMudWR0c1t1ZHRLZXldKTtcbiAgICAgICAgY29uc3QgdWR0VmFsdWVzID0gXy5tYXAoXy52YWx1ZXMob3B0aW9ucy51ZHRzW3VkdEtleV0pLCBub3JtYWxpemVyLm5vcm1hbGl6ZV91c2VyX2RlZmluZWRfdHlwZSk7XG4gICAgICAgIGNvbnN0IGZpZWxkTmFtZXMgPSB1ZHRPYmplY3QuZmllbGRfbmFtZXM7XG4gICAgICAgIGNvbnN0IGZpZWxkVHlwZXMgPSBfLm1hcCh1ZHRPYmplY3QuZmllbGRfdHlwZXMsIG5vcm1hbGl6ZXIubm9ybWFsaXplX3VzZXJfZGVmaW5lZF90eXBlKTtcblxuICAgICAgICBpZiAoXy5kaWZmZXJlbmNlKHVkdEtleXMsIGZpZWxkTmFtZXMpLmxlbmd0aCA9PT0gMCAmJiBfLmRpZmZlcmVuY2UodWR0VmFsdWVzLCBmaWVsZFR5cGVzKS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICB1ZHRDYWxsYmFjaygpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IChuZXcgRXJyb3IodXRpbC5mb3JtYXQoXG4gICAgICAgICAgJ1VzZXIgZGVmaW5lZCB0eXBlIFwiJXNcIiBhbHJlYWR5IGV4aXN0cyBidXQgZG9lcyBub3QgbWF0Y2ggdGhlIHVkdCBkZWZpbml0aW9uLiAnICtcbiAgICAgICAgICAnQ29uc2lkZXIgYWx0ZXJpbmcgb3IgZHJvcGluZyB0aGUgdHlwZS4nLFxuICAgICAgICAgIHVkdEtleSxcbiAgICAgICAgKSkpO1xuICAgICAgfSk7XG4gICAgfSkpXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnIpID0+IHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIH0pO1xuICB9LFxuXG4gIF9hc3NlcnRfdXNlcl9kZWZpbmVkX2Z1bmN0aW9ucyhjYWxsYmFjaykge1xuICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuX2RlZmluZV9jb25uZWN0aW9uO1xuICAgIGNvbnN0IG9wdGlvbnMgPSB0aGlzLl9vcHRpb25zO1xuICAgIGNvbnN0IGtleXNwYWNlID0gdGhpcy5fa2V5c3BhY2U7XG5cbiAgICBpZiAoIW9wdGlvbnMudWRmcykge1xuICAgICAgY2FsbGJhY2soKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCB1ZGZCdWlsZGVyID0gbmV3IFVkZkJ1aWxkZXIoY2xpZW50KTtcblxuICAgIFByb21pc2UubWFwU2VyaWVzKE9iamVjdC5rZXlzKG9wdGlvbnMudWRmcyksICh1ZGZLZXkpID0+IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHVkZkNhbGxiYWNrID0gKGVycikgPT4ge1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgcmVqZWN0KGVycik7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH07XG5cbiAgICAgIHVkZkJ1aWxkZXIudmFsaWRhdGVfZGVmaW5pdGlvbih1ZGZLZXksIG9wdGlvbnMudWRmc1t1ZGZLZXldKTtcblxuICAgICAgdWRmQnVpbGRlci5nZXRfdWRmKHVkZktleSwga2V5c3BhY2UsIChlcnIsIHVkZk9iamVjdCkgPT4ge1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgdWRmQ2FsbGJhY2soZXJyKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXVkZk9iamVjdCkge1xuICAgICAgICAgIHVkZkJ1aWxkZXIuY3JlYXRlX3VkZih1ZGZLZXksIG9wdGlvbnMudWRmc1t1ZGZLZXldLCB1ZGZDYWxsYmFjayk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdWRmTGFuZ3VhZ2UgPSBvcHRpb25zLnVkZnNbdWRmS2V5XS5sYW5ndWFnZTtcbiAgICAgICAgY29uc3QgcmVzdWx0TGFuZ3VhZ2UgPSB1ZGZPYmplY3QubGFuZ3VhZ2U7XG5cbiAgICAgICAgY29uc3QgdWRmQ29kZSA9IG9wdGlvbnMudWRmc1t1ZGZLZXldLmNvZGU7XG4gICAgICAgIGNvbnN0IHJlc3VsdENvZGUgPSB1ZGZPYmplY3QuYm9keTtcblxuICAgICAgICBjb25zdCB1ZGZSZXR1cm5UeXBlID0gbm9ybWFsaXplci5ub3JtYWxpemVfdXNlcl9kZWZpbmVkX3R5cGUob3B0aW9ucy51ZGZzW3VkZktleV0ucmV0dXJuVHlwZSk7XG4gICAgICAgIGNvbnN0IHJlc3VsdFJldHVyblR5cGUgPSBub3JtYWxpemVyLm5vcm1hbGl6ZV91c2VyX2RlZmluZWRfdHlwZSh1ZGZPYmplY3QucmV0dXJuX3R5cGUpO1xuXG4gICAgICAgIGNvbnN0IHVkZklucHV0cyA9IG9wdGlvbnMudWRmc1t1ZGZLZXldLmlucHV0cyA/IG9wdGlvbnMudWRmc1t1ZGZLZXldLmlucHV0cyA6IHt9O1xuICAgICAgICBjb25zdCB1ZGZJbnB1dEtleXMgPSBPYmplY3Qua2V5cyh1ZGZJbnB1dHMpO1xuICAgICAgICBjb25zdCB1ZGZJbnB1dFZhbHVlcyA9IF8ubWFwKF8udmFsdWVzKHVkZklucHV0cyksIG5vcm1hbGl6ZXIubm9ybWFsaXplX3VzZXJfZGVmaW5lZF90eXBlKTtcbiAgICAgICAgY29uc3QgcmVzdWx0QXJndW1lbnROYW1lcyA9IHVkZk9iamVjdC5hcmd1bWVudF9uYW1lcztcbiAgICAgICAgY29uc3QgcmVzdWx0QXJndW1lbnRUeXBlcyA9IF8ubWFwKHVkZk9iamVjdC5hcmd1bWVudF90eXBlcywgbm9ybWFsaXplci5ub3JtYWxpemVfdXNlcl9kZWZpbmVkX3R5cGUpO1xuXG4gICAgICAgIGlmICh1ZGZMYW5ndWFnZSA9PT0gcmVzdWx0TGFuZ3VhZ2UgJiZcbiAgICAgICAgICB1ZGZDb2RlID09PSByZXN1bHRDb2RlICYmXG4gICAgICAgICAgdWRmUmV0dXJuVHlwZSA9PT0gcmVzdWx0UmV0dXJuVHlwZSAmJlxuICAgICAgICAgIF8uaXNFcXVhbCh1ZGZJbnB1dEtleXMsIHJlc3VsdEFyZ3VtZW50TmFtZXMpICYmXG4gICAgICAgICAgXy5pc0VxdWFsKHVkZklucHV0VmFsdWVzLCByZXN1bHRBcmd1bWVudFR5cGVzKSkge1xuICAgICAgICAgIHVkZkNhbGxiYWNrKCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdWRmQnVpbGRlci5jcmVhdGVfdWRmKHVkZktleSwgb3B0aW9ucy51ZGZzW3VkZktleV0sIHVkZkNhbGxiYWNrKTtcbiAgICAgIH0pO1xuICAgIH0pKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICB9KTtcbiAgfSxcblxuICBfYXNzZXJ0X3VzZXJfZGVmaW5lZF9hZ2dyZWdhdGVzKGNhbGxiYWNrKSB7XG4gICAgY29uc3QgY2xpZW50ID0gdGhpcy5fZGVmaW5lX2Nvbm5lY3Rpb247XG4gICAgY29uc3Qgb3B0aW9ucyA9IHRoaXMuX29wdGlvbnM7XG4gICAgY29uc3Qga2V5c3BhY2UgPSB0aGlzLl9rZXlzcGFjZTtcblxuICAgIGlmICghb3B0aW9ucy51ZGFzKSB7XG4gICAgICBjYWxsYmFjaygpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHVkYUJ1aWxkZXIgPSBuZXcgVWRhQnVpbGRlcihjbGllbnQpO1xuXG4gICAgUHJvbWlzZS5tYXBTZXJpZXMoT2JqZWN0LmtleXMob3B0aW9ucy51ZGFzKSwgKHVkYUtleSkgPT4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdWRhQ2FsbGJhY2sgPSAoZXJyKSA9PiB7XG4gICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICByZWplY3QoZXJyKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgfTtcblxuICAgICAgdWRhQnVpbGRlci52YWxpZGF0ZV9kZWZpbml0aW9uKHVkYUtleSwgb3B0aW9ucy51ZGFzW3VkYUtleV0pO1xuXG4gICAgICBpZiAoIW9wdGlvbnMudWRhc1t1ZGFLZXldLmluaXRjb25kKSB7XG4gICAgICAgIG9wdGlvbnMudWRhc1t1ZGFLZXldLmluaXRjb25kID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgdWRhQnVpbGRlci5nZXRfdWRhKHVkYUtleSwga2V5c3BhY2UsIChlcnIsIHVkYU9iamVjdHMpID0+IHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIHVkYUNhbGxiYWNrKGVycik7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF1ZGFPYmplY3RzKSB7XG4gICAgICAgICAgdWRhQnVpbGRlci5jcmVhdGVfdWRhKHVkYUtleSwgb3B0aW9ucy51ZGFzW3VkYUtleV0sIHVkYUNhbGxiYWNrKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBpbnB1dFR5cGVzID0gXy5tYXAob3B0aW9ucy51ZGFzW3VkYUtleV0uaW5wdXRfdHlwZXMsIG5vcm1hbGl6ZXIubm9ybWFsaXplX3VzZXJfZGVmaW5lZF90eXBlKTtcbiAgICAgICAgY29uc3Qgc2Z1bmMgPSBvcHRpb25zLnVkYXNbdWRhS2V5XS5zZnVuYy50b0xvd2VyQ2FzZSgpO1xuICAgICAgICBjb25zdCBzdHlwZSA9IG5vcm1hbGl6ZXIubm9ybWFsaXplX3VzZXJfZGVmaW5lZF90eXBlKG9wdGlvbnMudWRhc1t1ZGFLZXldLnN0eXBlKTtcbiAgICAgICAgY29uc3QgZmluYWxmdW5jID0gb3B0aW9ucy51ZGFzW3VkYUtleV0uZmluYWxmdW5jID8gb3B0aW9ucy51ZGFzW3VkYUtleV0uZmluYWxmdW5jLnRvTG93ZXJDYXNlKCkgOiBudWxsO1xuICAgICAgICBjb25zdCBpbml0Y29uZCA9IG9wdGlvbnMudWRhc1t1ZGFLZXldLmluaXRjb25kID8gb3B0aW9ucy51ZGFzW3VkYUtleV0uaW5pdGNvbmQucmVwbGFjZSgvW1xcc10vZywgJycpIDogbnVsbDtcblxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHVkYU9iamVjdHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICBjb25zdCByZXN1bHRBcmd1bWVudFR5cGVzID0gXy5tYXAodWRhT2JqZWN0c1tpXS5hcmd1bWVudF90eXBlcywgbm9ybWFsaXplci5ub3JtYWxpemVfdXNlcl9kZWZpbmVkX3R5cGUpO1xuXG4gICAgICAgICAgY29uc3QgcmVzdWx0U3RhdGVGdW5jID0gdWRhT2JqZWN0c1tpXS5zdGF0ZV9mdW5jO1xuICAgICAgICAgIGNvbnN0IHJlc3VsdFN0YXRlVHlwZSA9IG5vcm1hbGl6ZXIubm9ybWFsaXplX3VzZXJfZGVmaW5lZF90eXBlKHVkYU9iamVjdHNbaV0uc3RhdGVfdHlwZSk7XG4gICAgICAgICAgY29uc3QgcmVzdWx0RmluYWxGdW5jID0gdWRhT2JqZWN0c1tpXS5maW5hbF9mdW5jO1xuICAgICAgICAgIGNvbnN0IHJlc3VsdEluaXRjb25kID0gdWRhT2JqZWN0c1tpXS5pbml0Y29uZCA/IHVkYU9iamVjdHNbaV0uaW5pdGNvbmQucmVwbGFjZSgvW1xcc10vZywgJycpIDogbnVsbDtcblxuICAgICAgICAgIGlmIChzZnVuYyA9PT0gcmVzdWx0U3RhdGVGdW5jICYmXG4gICAgICAgICAgICBzdHlwZSA9PT0gcmVzdWx0U3RhdGVUeXBlICYmXG4gICAgICAgICAgICBmaW5hbGZ1bmMgPT09IHJlc3VsdEZpbmFsRnVuYyAmJlxuICAgICAgICAgICAgaW5pdGNvbmQgPT09IHJlc3VsdEluaXRjb25kICYmXG4gICAgICAgICAgICBfLmlzRXF1YWwoaW5wdXRUeXBlcywgcmVzdWx0QXJndW1lbnRUeXBlcykpIHtcbiAgICAgICAgICAgIHVkYUNhbGxiYWNrKCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHVkYUJ1aWxkZXIuY3JlYXRlX3VkYSh1ZGFLZXksIG9wdGlvbnMudWRhc1t1ZGFLZXldLCB1ZGFDYWxsYmFjayk7XG4gICAgICB9KTtcbiAgICB9KSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgfSk7XG4gIH0sXG5cbiAgX3NldF9jbGllbnQoY2xpZW50KSB7XG4gICAgY29uc3QgZGVmaW5lQ29ubmVjdGlvbk9wdGlvbnMgPSBfLmNsb25lRGVlcCh0aGlzLl9jb25uZWN0aW9uKTtcblxuICAgIHRoaXMuX2NsaWVudCA9IGNsaWVudDtcbiAgICB0aGlzLl9kZWZpbmVfY29ubmVjdGlvbiA9IG5ldyBjcWwuQ2xpZW50KGRlZmluZUNvbm5lY3Rpb25PcHRpb25zKTtcblxuICAgIC8vIFJlc2V0IGNvbm5lY3Rpb25zIG9uIGFsbCBtb2RlbHNcbiAgICBPYmplY3Qua2V5cyh0aGlzLl9tb2RlbHMpLmZvckVhY2goKGkpID0+IHtcbiAgICAgIGlmKHRoaXMuX21vZGVsc1tpXS5fcHJvcGVydGllcy5jcWwgJiYgdHlwZW9mIHRoaXMuX21vZGVsc1tpXS5fcHJvcGVydGllcy5jcWwuY2xvc2UgPT09IFwiZnVuY3Rpb25cIil7XG4gICAgICAgIHRoaXMuX21vZGVsc1tpXS5fcHJvcGVydGllcy5jcWwuc2h1dGRvd24oKCk9Pnt9KTtcbiAgICAgIH1cbiAgICAgIHRoaXMuX21vZGVsc1tpXS5fcHJvcGVydGllcy5jcWwgPSB0aGlzLl9jbGllbnQ7XG4gICAgICBcbiAgICAgIGlmKHRoaXMuX21vZGVsc1tpXS5fcHJvcGVydGllcy5kZWZpbmVfY29ubmVjdGlvbiAmJiB0eXBlb2YgdGhpcy5fbW9kZWxzW2ldLl9wcm9wZXJ0aWVzLmRlZmluZV9jb25uZWN0aW9uLmNsb3NlID09PSBcImZ1bmN0aW9uXCIpe1xuICAgICAgICB0aGlzLl9tb2RlbHNbaV0uX3Byb3BlcnRpZXMuZGVmaW5lX2Nvbm5lY3Rpb24uc2h1dGRvd24oKCk9Pnt9KTtcbiAgICAgIH1cbiAgICAgIHRoaXMuX21vZGVsc1tpXS5fcHJvcGVydGllcy5kZWZpbmVfY29ubmVjdGlvbiA9IHRoaXMuX2RlZmluZV9jb25uZWN0aW9uO1xuICAgIH0pO1xuICB9LFxuXG4gIGluaXQoY2FsbGJhY2spIHtcbiAgICBjb25zdCBvblVzZXJEZWZpbmVkQWdncmVnYXRlcyA9IChlcnIpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBtYW5hZ2VtZW50VGFza3MgPSBbXTtcbiAgICAgIGlmICh0aGlzLl9rZXlzcGFjZSAmJiB0aGlzLl9vcHRpb25zLm1hbmFnZUVTSW5kZXgpIHtcbiAgICAgICAgdGhpcy5hc3NlcnRFU0luZGV4QXN5bmMgPSBQcm9taXNlLnByb21pc2lmeSh0aGlzLl9hc3NlcnRfZXNfaW5kZXgpO1xuICAgICAgICBtYW5hZ2VtZW50VGFza3MucHVzaCh0aGlzLmFzc2VydEVTSW5kZXhBc3luYygpKTtcbiAgICAgIH1cbiAgICAgIGlmICh0aGlzLl9rZXlzcGFjZSAmJiB0aGlzLl9vcHRpb25zLm1hbmFnZUdyYXBocykge1xuICAgICAgICB0aGlzLmFzc2VydEdyZW1saW5HcmFwaEFzeW5jID0gUHJvbWlzZS5wcm9taXNpZnkodGhpcy5fYXNzZXJ0X2dyZW1saW5fZ3JhcGgpO1xuICAgICAgICBtYW5hZ2VtZW50VGFza3MucHVzaCh0aGlzLmFzc2VydEdyZW1saW5HcmFwaEFzeW5jKCkpO1xuICAgICAgfVxuICAgICAgUHJvbWlzZS5hbGwobWFuYWdlbWVudFRhc2tzKVxuICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgY2FsbGJhY2sobnVsbCwgdGhpcyk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZXJyMSkgPT4ge1xuICAgICAgICAgIGNhbGxiYWNrKGVycjEpO1xuICAgICAgICB9KTtcbiAgICB9O1xuXG4gICAgY29uc3Qgb25Vc2VyRGVmaW5lZEZ1bmN0aW9ucyA9IGZ1bmN0aW9uIGYoZXJyKSB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIHRoaXMuX2Fzc2VydF91c2VyX2RlZmluZWRfYWdncmVnYXRlcyhvblVzZXJEZWZpbmVkQWdncmVnYXRlcy5iaW5kKHRoaXMpKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnZhbGlkYXRvci5pbnZhbGlkdWRhJywgZS5tZXNzYWdlKSk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIGNvbnN0IG9uVXNlckRlZmluZWRUeXBlcyA9IGZ1bmN0aW9uIGYoZXJyKSB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIHRoaXMuX2Fzc2VydF91c2VyX2RlZmluZWRfZnVuY3Rpb25zKG9uVXNlckRlZmluZWRGdW5jdGlvbnMuYmluZCh0aGlzKSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHVkZicsIGUubWVzc2FnZSkpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICBjb25zdCBvbktleXNwYWNlID0gZnVuY3Rpb24gZihlcnIpIHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5fc2V0X2NsaWVudChuZXcgY3FsLkNsaWVudCh0aGlzLl9jb25uZWN0aW9uKSk7XG4gICAgICB0cnkge1xuICAgICAgICB0aGlzLl9hc3NlcnRfdXNlcl9kZWZpbmVkX3R5cGVzKG9uVXNlckRlZmluZWRUeXBlcy5iaW5kKHRoaXMpKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnZhbGlkYXRvci5pbnZhbGlkdWR0JywgZS5tZXNzYWdlKSk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIGlmICh0aGlzLl9rZXlzcGFjZSAmJiB0aGlzLl9vcHRpb25zLmNyZWF0ZUtleXNwYWNlICE9PSBmYWxzZSkge1xuICAgICAgdGhpcy5fYXNzZXJ0X2tleXNwYWNlKG9uS2V5c3BhY2UuYmluZCh0aGlzKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG9uS2V5c3BhY2UuY2FsbCh0aGlzKTtcbiAgICB9XG4gIH0sXG5cbiAgYWRkTW9kZWwobW9kZWxOYW1lLCBtb2RlbFNjaGVtYSkge1xuICAgIGlmICghbW9kZWxOYW1lIHx8IHR5cGVvZiAobW9kZWxOYW1lKSAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHNjaGVtYScsICdNb2RlbCBuYW1lIG11c3QgYmUgYSB2YWxpZCBzdHJpbmcnKSk7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIHNjaGVtZXIudmFsaWRhdGVfbW9kZWxfc2NoZW1hKG1vZGVsU2NoZW1hKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRzY2hlbWEnLCBlLm1lc3NhZ2UpKTtcbiAgICB9XG5cbiAgICBpZiAobW9kZWxTY2hlbWEub3B0aW9ucyAmJiBtb2RlbFNjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMpIHtcbiAgICAgIGNvbnN0IHRpbWVzdGFtcE9wdGlvbnMgPSB7XG4gICAgICAgIGNyZWF0ZWRBdDogbW9kZWxTY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzLmNyZWF0ZWRBdCB8fCAnY3JlYXRlZEF0JyxcbiAgICAgICAgdXBkYXRlZEF0OiBtb2RlbFNjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMudXBkYXRlZEF0IHx8ICd1cGRhdGVkQXQnLFxuICAgICAgfTtcbiAgICAgIG1vZGVsU2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcyA9IHRpbWVzdGFtcE9wdGlvbnM7XG5cbiAgICAgIG1vZGVsU2NoZW1hLmZpZWxkc1ttb2RlbFNjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMuY3JlYXRlZEF0XSA9IHtcbiAgICAgICAgdHlwZTogJ3RpbWVzdGFtcCcsXG4gICAgICAgIGRlZmF1bHQ6IHtcbiAgICAgICAgICAkZGJfZnVuY3Rpb246ICd0b1RpbWVzdGFtcChub3coKSknLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICAgIG1vZGVsU2NoZW1hLmZpZWxkc1ttb2RlbFNjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMudXBkYXRlZEF0XSA9IHtcbiAgICAgICAgdHlwZTogJ3RpbWVzdGFtcCcsXG4gICAgICAgIGRlZmF1bHQ6IHtcbiAgICAgICAgICAkZGJfZnVuY3Rpb246ICd0b1RpbWVzdGFtcChub3coKSknLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAobW9kZWxTY2hlbWEub3B0aW9ucyAmJiBtb2RlbFNjaGVtYS5vcHRpb25zLnZlcnNpb25zKSB7XG4gICAgICBjb25zdCB2ZXJzaW9uT3B0aW9ucyA9IHtcbiAgICAgICAga2V5OiBtb2RlbFNjaGVtYS5vcHRpb25zLnZlcnNpb25zLmtleSB8fCAnX192JyxcbiAgICAgIH07XG4gICAgICBtb2RlbFNjaGVtYS5vcHRpb25zLnZlcnNpb25zID0gdmVyc2lvbk9wdGlvbnM7XG5cbiAgICAgIG1vZGVsU2NoZW1hLmZpZWxkc1ttb2RlbFNjaGVtYS5vcHRpb25zLnZlcnNpb25zLmtleV0gPSB7XG4gICAgICAgIHR5cGU6ICd0aW1ldXVpZCcsXG4gICAgICAgIGRlZmF1bHQ6IHtcbiAgICAgICAgICAkZGJfZnVuY3Rpb246ICdub3coKScsXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IGJhc2VQcm9wZXJ0aWVzID0ge1xuICAgICAgbmFtZTogbW9kZWxOYW1lLFxuICAgICAgc2NoZW1hOiBtb2RlbFNjaGVtYSxcbiAgICAgIGtleXNwYWNlOiB0aGlzLl9rZXlzcGFjZSxcbiAgICAgIGNvbm5lY3Rpb25fb3B0aW9uczogdGhpcy5fY29ubmVjdGlvbixcbiAgICAgIGRlZmluZV9jb25uZWN0aW9uOiB0aGlzLl9kZWZpbmVfY29ubmVjdGlvbixcbiAgICAgIGNxbDogdGhpcy5fY2xpZW50LFxuICAgICAgZXNjbGllbnQ6IHRoaXMuX2VzY2xpZW50LFxuICAgICAgZ3JlbWxpbl9jbGllbnQ6IHRoaXMuX2dyZW1saW5fY2xpZW50LFxuICAgICAgZ2V0X2NvbnN0cnVjdG9yOiB0aGlzLmdldE1vZGVsLmJpbmQodGhpcywgbW9kZWxOYW1lKSxcbiAgICAgIGluaXQ6IHRoaXMuaW5pdC5iaW5kKHRoaXMpLFxuICAgICAgZHJvcFRhYmxlT25TY2hlbWFDaGFuZ2U6IHRoaXMuX29wdGlvbnMuZHJvcFRhYmxlT25TY2hlbWFDaGFuZ2UsXG4gICAgICBjcmVhdGVUYWJsZTogdGhpcy5fb3B0aW9ucy5jcmVhdGVUYWJsZSxcbiAgICAgIG1pZ3JhdGlvbjogdGhpcy5fb3B0aW9ucy5taWdyYXRpb24sXG4gICAgICBkaXNhYmxlVFRZQ29uZmlybWF0aW9uOiB0aGlzLl9vcHRpb25zLmRpc2FibGVUVFlDb25maXJtYXRpb24sXG4gICAgfTtcblxuICAgIHRoaXMuX21vZGVsc1ttb2RlbE5hbWVdID0gdGhpcy5fZ2VuZXJhdGVfbW9kZWwoYmFzZVByb3BlcnRpZXMpO1xuICAgIHJldHVybiB0aGlzLl9tb2RlbHNbbW9kZWxOYW1lXTtcbiAgfSxcblxuICBnZXRNb2RlbChtb2RlbE5hbWUpIHtcbiAgICByZXR1cm4gdGhpcy5fbW9kZWxzW21vZGVsTmFtZV0gfHwgbnVsbDtcbiAgfSxcblxuICBjbG9zZShjYWxsYmFjaykge1xuICAgIGNhbGxiYWNrID0gY2FsbGJhY2sgfHwgbm9vcDtcblxuICAgIGlmICh0aGlzLm9ybS5fZXNjbGllbnQpIHtcbiAgICAgIHRoaXMub3JtLl9lc2NsaWVudC5jbG9zZSgpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLm9ybS5fZ3JlbWxpbl9jbGllbnQgJiYgdGhpcy5vcm0uX2dyZW1saW5fY2xpZW50LmNvbm5lY3Rpb24gJiYgdGhpcy5vcm0uX2dyZW1saW5fY2xpZW50LmNvbm5lY3Rpb24ud3MpIHtcbiAgICAgIHRoaXMub3JtLl9ncmVtbGluX2NsaWVudC5jb25uZWN0aW9uLndzLmNsb3NlKCk7XG4gICAgfVxuXG4gICAgY29uc3QgY2xpZW50c1RvU2h1dGRvd24gPSBbXTtcbiAgICBpZiAodGhpcy5vcm0uX2NsaWVudCkge1xuICAgICAgY2xpZW50c1RvU2h1dGRvd24ucHVzaCh0aGlzLm9ybS5fY2xpZW50LnNodXRkb3duKCkpO1xuICAgIH1cbiAgICBpZiAodGhpcy5vcm0uX2RlZmluZV9jb25uZWN0aW9uKSB7XG4gICAgICBjbGllbnRzVG9TaHV0ZG93bi5wdXNoKHRoaXMub3JtLl9kZWZpbmVfY29ubmVjdGlvbi5zaHV0ZG93bigpKTtcbiAgICB9XG5cbiAgICBQcm9taXNlLmFsbChjbGllbnRzVG9TaHV0ZG93bilcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgfSk7XG4gIH0sXG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IEFwb2xsbztcbiJdfQ==