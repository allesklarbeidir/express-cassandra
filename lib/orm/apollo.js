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
      _this._models[i]._properties.cql = _this._client;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9vcm0vYXBvbGxvLmpzIl0sIm5hbWVzIjpbIlByb21pc2UiLCJyZXF1aXJlIiwidXRpbCIsIl8iLCJlbGFzdGljc2VhcmNoIiwiZSIsImdyZW1saW4iLCJkc2VEcml2ZXIiLCJjcWwiLCJwcm9taXNpZnlBbGwiLCJCYXNlTW9kZWwiLCJzY2hlbWVyIiwibm9ybWFsaXplciIsImJ1aWxkRXJyb3IiLCJLZXlzcGFjZUJ1aWxkZXIiLCJVZHRCdWlsZGVyIiwiVWRmQnVpbGRlciIsIlVkYUJ1aWxkZXIiLCJFbGFzc2FuZHJhQnVpbGRlciIsIkphbnVzR3JhcGhCdWlsZGVyIiwiREVGQVVMVF9SRVBMSUNBVElPTl9GQUNUT1IiLCJub29wIiwiQXBvbGxvIiwiZiIsImNvbm5lY3Rpb24iLCJvcHRpb25zIiwiZGVmYXVsdFJlcGxpY2F0aW9uU3RyYXRlZ3kiLCJjbGFzcyIsInJlcGxpY2F0aW9uX2ZhY3RvciIsIl9vcHRpb25zIiwiX21vZGVscyIsIl9rZXlzcGFjZSIsImtleXNwYWNlIiwiX2Nvbm5lY3Rpb24iLCJfY2xpZW50IiwiX2VzY2xpZW50IiwiX2dyZW1saW5fY2xpZW50IiwicHJvdG90eXBlIiwiX2dlbmVyYXRlX21vZGVsIiwicHJvcGVydGllcyIsIk1vZGVsIiwiYXJncyIsImFwcGx5IiwiQXJyYXkiLCJzbGljZSIsImNhbGwiLCJpbmhlcml0cyIsIk9iamVjdCIsImtleXMiLCJmb3JFYWNoIiwia2V5IiwiX3NldF9wcm9wZXJ0aWVzIiwiY3JlYXRlX2VzX2NsaWVudCIsIkVycm9yIiwiY29udGFjdFBvaW50cyIsImRlZmF1bHRIb3N0cyIsImhvc3QiLCJwdXNoIiwiZXNDbGllbnRDb25maWciLCJkZWZhdWx0cyIsImhvc3RzIiwic25pZmZPblN0YXJ0IiwiQ2xpZW50IiwiX2Fzc2VydF9lc19pbmRleCIsImNhbGxiYWNrIiwiZXNDbGllbnQiLCJpbmRleE5hbWUiLCJlbGFzc2FuZHJhQnVpbGRlciIsImFzc2VydF9pbmRleCIsImNyZWF0ZV9ncmVtbGluX2NsaWVudCIsImdyZW1saW5Db25maWciLCJwb3J0IiwiY3JlYXRlQ2xpZW50IiwiX2Fzc2VydF9ncmVtbGluX2dyYXBoIiwiZ3JlbWxpbkNsaWVudCIsImtleXNwYWNlTmFtZSIsImdyYXBoTmFtZSIsImdyYXBoQnVpbGRlciIsImFzc2VydF9ncmFwaCIsImdldF9zeXN0ZW1fY2xpZW50IiwiY2xvbmVEZWVwIiwiZ2V0X2tleXNwYWNlX25hbWUiLCJfYXNzZXJ0X2tleXNwYWNlIiwiY2xpZW50Iiwia2V5c3BhY2VCdWlsZGVyIiwiZ2V0X2tleXNwYWNlIiwiZXJyIiwia2V5c3BhY2VPYmplY3QiLCJjcmVhdGVfa2V5c3BhY2UiLCJkYlJlcGxpY2F0aW9uIiwibm9ybWFsaXplX3JlcGxpY2F0aW9uX29wdGlvbiIsInJlcGxpY2F0aW9uIiwib3JtUmVwbGljYXRpb24iLCJpc0VxdWFsIiwiYWx0ZXJfa2V5c3BhY2UiLCJzaHV0ZG93biIsIl9hc3NlcnRfdXNlcl9kZWZpbmVkX3R5cGVzIiwiX2RlZmluZV9jb25uZWN0aW9uIiwidWR0cyIsInVkdEJ1aWxkZXIiLCJtYXBTZXJpZXMiLCJ1ZHRLZXkiLCJyZXNvbHZlIiwicmVqZWN0IiwidWR0Q2FsbGJhY2siLCJnZXRfdWR0IiwidWR0T2JqZWN0IiwiY3JlYXRlX3VkdCIsInVkdEtleXMiLCJ1ZHRWYWx1ZXMiLCJtYXAiLCJ2YWx1ZXMiLCJub3JtYWxpemVfdXNlcl9kZWZpbmVkX3R5cGUiLCJmaWVsZE5hbWVzIiwiZmllbGRfbmFtZXMiLCJmaWVsZFR5cGVzIiwiZmllbGRfdHlwZXMiLCJkaWZmZXJlbmNlIiwibGVuZ3RoIiwiZm9ybWF0IiwidGhlbiIsImNhdGNoIiwiX2Fzc2VydF91c2VyX2RlZmluZWRfZnVuY3Rpb25zIiwidWRmcyIsInVkZkJ1aWxkZXIiLCJ1ZGZLZXkiLCJ1ZGZDYWxsYmFjayIsInZhbGlkYXRlX2RlZmluaXRpb24iLCJnZXRfdWRmIiwidWRmT2JqZWN0IiwiY3JlYXRlX3VkZiIsInVkZkxhbmd1YWdlIiwibGFuZ3VhZ2UiLCJyZXN1bHRMYW5ndWFnZSIsInVkZkNvZGUiLCJjb2RlIiwicmVzdWx0Q29kZSIsImJvZHkiLCJ1ZGZSZXR1cm5UeXBlIiwicmV0dXJuVHlwZSIsInJlc3VsdFJldHVyblR5cGUiLCJyZXR1cm5fdHlwZSIsInVkZklucHV0cyIsImlucHV0cyIsInVkZklucHV0S2V5cyIsInVkZklucHV0VmFsdWVzIiwicmVzdWx0QXJndW1lbnROYW1lcyIsImFyZ3VtZW50X25hbWVzIiwicmVzdWx0QXJndW1lbnRUeXBlcyIsImFyZ3VtZW50X3R5cGVzIiwiX2Fzc2VydF91c2VyX2RlZmluZWRfYWdncmVnYXRlcyIsInVkYXMiLCJ1ZGFCdWlsZGVyIiwidWRhS2V5IiwidWRhQ2FsbGJhY2siLCJpbml0Y29uZCIsImdldF91ZGEiLCJ1ZGFPYmplY3RzIiwiY3JlYXRlX3VkYSIsImlucHV0VHlwZXMiLCJpbnB1dF90eXBlcyIsInNmdW5jIiwidG9Mb3dlckNhc2UiLCJzdHlwZSIsImZpbmFsZnVuYyIsInJlcGxhY2UiLCJpIiwicmVzdWx0U3RhdGVGdW5jIiwic3RhdGVfZnVuYyIsInJlc3VsdFN0YXRlVHlwZSIsInN0YXRlX3R5cGUiLCJyZXN1bHRGaW5hbEZ1bmMiLCJmaW5hbF9mdW5jIiwicmVzdWx0SW5pdGNvbmQiLCJfc2V0X2NsaWVudCIsImRlZmluZUNvbm5lY3Rpb25PcHRpb25zIiwiX3Byb3BlcnRpZXMiLCJkZWZpbmVfY29ubmVjdGlvbiIsImluaXQiLCJvblVzZXJEZWZpbmVkQWdncmVnYXRlcyIsIm1hbmFnZW1lbnRUYXNrcyIsIm1hbmFnZUVTSW5kZXgiLCJhc3NlcnRFU0luZGV4QXN5bmMiLCJwcm9taXNpZnkiLCJtYW5hZ2VHcmFwaHMiLCJhc3NlcnRHcmVtbGluR3JhcGhBc3luYyIsImFsbCIsImVycjEiLCJvblVzZXJEZWZpbmVkRnVuY3Rpb25zIiwiYmluZCIsIm1lc3NhZ2UiLCJvblVzZXJEZWZpbmVkVHlwZXMiLCJvbktleXNwYWNlIiwiY3JlYXRlS2V5c3BhY2UiLCJhZGRNb2RlbCIsIm1vZGVsTmFtZSIsIm1vZGVsU2NoZW1hIiwidmFsaWRhdGVfbW9kZWxfc2NoZW1hIiwidGltZXN0YW1wcyIsInRpbWVzdGFtcE9wdGlvbnMiLCJjcmVhdGVkQXQiLCJ1cGRhdGVkQXQiLCJmaWVsZHMiLCJ0eXBlIiwiZGVmYXVsdCIsIiRkYl9mdW5jdGlvbiIsInZlcnNpb25zIiwidmVyc2lvbk9wdGlvbnMiLCJiYXNlUHJvcGVydGllcyIsIm5hbWUiLCJzY2hlbWEiLCJlc2NsaWVudCIsImdyZW1saW5fY2xpZW50IiwiZ2V0X2NvbnN0cnVjdG9yIiwiZ2V0TW9kZWwiLCJkcm9wVGFibGVPblNjaGVtYUNoYW5nZSIsImNyZWF0ZVRhYmxlIiwibWlncmF0aW9uIiwiZGlzYWJsZVRUWUNvbmZpcm1hdGlvbiIsImNsb3NlIiwib3JtIiwid3MiLCJjbGllbnRzVG9TaHV0ZG93biIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7O0FBQUEsSUFBTUEsVUFBVUMsUUFBUSxVQUFSLENBQWhCO0FBQ0EsSUFBTUMsT0FBT0QsUUFBUSxNQUFSLENBQWI7QUFDQSxJQUFNRSxJQUFJRixRQUFRLFFBQVIsQ0FBVjs7QUFFQSxJQUFJRyxzQkFBSjtBQUNBLElBQUk7QUFDRjtBQUNBQSxrQkFBZ0JILFFBQVEsZUFBUixDQUFoQjtBQUNELENBSEQsQ0FHRSxPQUFPSSxDQUFQLEVBQVU7QUFDVkQsa0JBQWdCLElBQWhCO0FBQ0Q7O0FBRUQsSUFBSUUsZ0JBQUo7QUFDQSxJQUFJO0FBQ0Y7QUFDQUEsWUFBVUwsUUFBUSxTQUFSLENBQVY7QUFDRCxDQUhELENBR0UsT0FBT0ksQ0FBUCxFQUFVO0FBQ1ZDLFlBQVUsSUFBVjtBQUNEOztBQUVELElBQUlDLGtCQUFKO0FBQ0EsSUFBSTtBQUNGO0FBQ0FBLGNBQVlOLFFBQVEsWUFBUixDQUFaO0FBQ0QsQ0FIRCxDQUdFLE9BQU9JLENBQVAsRUFBVTtBQUNWRSxjQUFZLElBQVo7QUFDRDs7QUFFRCxJQUFNQyxNQUFNUixRQUFRUyxZQUFSLENBQXFCRixhQUFh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R0FBTCxDQUFTekwsU0FBVCxDQUFtQndMLEtBQW5CO0FBQ0Q7O0FBRUQsUUFBSSxLQUFLQyxHQUFMLENBQVN4TCxlQUFULElBQTRCLEtBQUt3TCxHQUFMLENBQVN4TCxlQUFULENBQXlCWixVQUFyRCxJQUFtRSxLQUFLb00sR0FBTCxDQUFTeEwsZUFBVCxDQUF5QlosVUFBekIsQ0FBb0NxTSxFQUEzRyxFQUErRztBQUM3RyxXQUFLRCxHQUFMLENBQVN4TCxlQUFULENBQXlCWixVQUF6QixDQUFvQ3FNLEVBQXBDLENBQXVDRixLQUF2QztBQUNEOztBQUVELFFBQU1HLG9CQUFvQixFQUExQjtBQUNBLFFBQUksS0FBS0YsR0FBTCxDQUFTMUwsT0FBYixFQUFzQjtBQUNwQjRMLHdCQUFrQnJLLElBQWxCLENBQXVCLEtBQUttSyxHQUFMLENBQVMxTCxPQUFULENBQWlCNkQsUUFBakIsRUFBdkI7QUFDRDtBQUNELFFBQUksS0FBSzZILEdBQUwsQ0FBUzNILGtCQUFiLEVBQWlDO0FBQy9CNkgsd0JBQWtCckssSUFBbEIsQ0FBdUIsS0FBS21LLEdBQUwsQ0FBUzNILGtCQUFULENBQTRCRixRQUE1QixFQUF2QjtBQUNEOztBQUVEL0YsWUFBUTBMLEdBQVIsQ0FBWW9DLGlCQUFaLEVBQ0d0RyxJQURILENBQ1EsWUFBTTtBQUNWeEQ7QUFDRCxLQUhILEVBSUd5RCxLQUpILENBSVMsVUFBQ25DLEdBQUQsRUFBUztBQUNkdEIsZUFBU3NCLEdBQVQ7QUFDRCxLQU5IO0FBT0Q7QUE1ZWdCLENBQW5COztBQStlQXlJLE9BQU9DLE9BQVAsR0FBaUIxTSxNQUFqQiIsImZpbGUiOiJhcG9sbG8uanMiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCBQcm9taXNlID0gcmVxdWlyZSgnYmx1ZWJpcmQnKTtcbmNvbnN0IHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5jb25zdCBfID0gcmVxdWlyZSgnbG9kYXNoJyk7XG5cbmxldCBlbGFzdGljc2VhcmNoO1xudHJ5IHtcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGltcG9ydC9uby1leHRyYW5lb3VzLWRlcGVuZGVuY2llcywgaW1wb3J0L25vLXVucmVzb2x2ZWRcbiAgZWxhc3RpY3NlYXJjaCA9IHJlcXVpcmUoJ2VsYXN0aWNzZWFyY2gnKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZWxhc3RpY3NlYXJjaCA9IG51bGw7XG59XG5cbmxldCBncmVtbGluO1xudHJ5IHtcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGltcG9ydC9uby1leHRyYW5lb3VzLWRlcGVuZGVuY2llcywgaW1wb3J0L25vLXVucmVzb2x2ZWRcbiAgZ3JlbWxpbiA9IHJlcXVpcmUoJ2dyZW1saW4nKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZ3JlbWxpbiA9IG51bGw7XG59XG5cbmxldCBkc2VEcml2ZXI7XG50cnkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgaW1wb3J0L25vLWV4dHJhbmVvdXMtZGVwZW5kZW5jaWVzLCBpbXBvcnQvbm8tdW5yZXNvbHZlZFxuICBkc2VEcml2ZXIgPSByZXF1aXJlKCdkc2UtZHJpdmVyJyk7XG59IGNhdGNoIChlKSB7XG4gIGRzZURyaXZlciA9IG51bGw7XG59XG5cbmNvbnN0IGNxbCA9IFByb21pc2UucHJvbWlzaWZ5QWxsKGRzZURyaXZlciB8fCByZXF1aXJlKCdjYXNzYW5kcmEtZHJpdmVyJykpO1xuXG5jb25zdCBCYXNlTW9kZWwgPSByZXF1aXJlKCcuL2Jhc2VfbW9kZWwnKTtcbmNvbnN0IHNjaGVtZXIgPSByZXF1aXJlKCcuLi92YWxpZGF0b3JzL3NjaGVtYScpO1xuY29uc3Qgbm9ybWFsaXplciA9IHJlcXVpcmUoJy4uL3V0aWxzL25vcm1hbGl6ZXInKTtcbmNvbnN0IGJ1aWxkRXJyb3IgPSByZXF1aXJlKCcuL2Fwb2xsb19lcnJvci5qcycpO1xuXG5jb25zdCBLZXlzcGFjZUJ1aWxkZXIgPSByZXF1aXJlKCcuLi9idWlsZGVycy9rZXlzcGFjZScpO1xuY29uc3QgVWR0QnVpbGRlciA9IHJlcXVpcmUoJy4uL2J1aWxkZXJzL3VkdCcpO1xuY29uc3QgVWRmQnVpbGRlciA9IHJlcXVpcmUoJy4uL2J1aWxkZXJzL3VkZicpO1xuY29uc3QgVWRhQnVpbGRlciA9IHJlcXVpcmUoJy4uL2J1aWxkZXJzL3VkYScpO1xuY29uc3QgRWxhc3NhbmRyYUJ1aWxkZXIgPSByZXF1aXJlKCcuLi9idWlsZGVycy9lbGFzc2FuZHJhJyk7XG5jb25zdCBKYW51c0dyYXBoQnVpbGRlciA9IHJlcXVpcmUoJy4uL2J1aWxkZXJzL2phbnVzZ3JhcGgnKTtcblxuY29uc3QgREVGQVVMVF9SRVBMSUNBVElPTl9GQUNUT1IgPSAxO1xuXG5jb25zdCBub29wID0gKCkgPT4ge307XG5cbmNvbnN0IEFwb2xsbyA9IGZ1bmN0aW9uIGYoY29ubmVjdGlvbiwgb3B0aW9ucykge1xuICBpZiAoIWNvbm5lY3Rpb24pIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRjb25maWcnLCAnQ2Fzc2FuZHJhIGNvbm5lY3Rpb24gY29uZmlndXJhdGlvbiB1bmRlZmluZWQnKSk7XG4gIH1cblxuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcblxuICBpZiAoIW9wdGlvbnMuZGVmYXVsdFJlcGxpY2F0aW9uU3RyYXRlZ3kpIHtcbiAgICBvcHRpb25zLmRlZmF1bHRSZXBsaWNhdGlvblN0cmF0ZWd5ID0ge1xuICAgICAgY2xhc3M6ICdTaW1wbGVTdHJhdGVneScsXG4gICAgICByZXBsaWNhdGlvbl9mYWN0b3I6IERFRkFVTFRfUkVQTElDQVRJT05fRkFDVE9SLFxuICAgIH07XG4gIH1cblxuICB0aGlzLl9vcHRpb25zID0gb3B0aW9ucztcbiAgdGhpcy5fbW9kZWxzID0ge307XG4gIHRoaXMuX2tleXNwYWNlID0gY29ubmVjdGlvbi5rZXlzcGFjZTtcbiAgdGhpcy5fY29ubmVjdGlvbiA9IGNvbm5lY3Rpb247XG4gIHRoaXMuX2NsaWVudCA9IG51bGw7XG4gIHRoaXMuX2VzY2xpZW50ID0gbnVsbDtcbiAgdGhpcy5fZ3JlbWxpbl9jbGllbnQgPSBudWxsO1xufTtcblxuQXBvbGxvLnByb3RvdHlwZSA9IHtcblxuICBfZ2VuZXJhdGVfbW9kZWwocHJvcGVydGllcykge1xuICAgIGNvbnN0IE1vZGVsID0gZnVuY3Rpb24gZiguLi5hcmdzKSB7XG4gICAgICBCYXNlTW9kZWwuYXBwbHkodGhpcywgQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJncykpO1xuICAgIH07XG5cbiAgICB1dGlsLmluaGVyaXRzKE1vZGVsLCBCYXNlTW9kZWwpO1xuXG4gICAgT2JqZWN0LmtleXMoQmFzZU1vZGVsKS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAgIE1vZGVsW2tleV0gPSBCYXNlTW9kZWxba2V5XTtcbiAgICB9KTtcblxuICAgIE1vZGVsLl9zZXRfcHJvcGVydGllcyhwcm9wZXJ0aWVzKTtcblxuICAgIHJldHVybiBNb2RlbDtcbiAgfSxcblxuICBjcmVhdGVfZXNfY2xpZW50KCkge1xuICAgIGlmICghZWxhc3RpY3NlYXJjaCkge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcignQ29uZmlndXJlZCB0byB1c2UgZWxhc3NhbmRyYSwgYnV0IGVsYXN0aWNzZWFyY2ggbW9kdWxlIHdhcyBub3QgZm91bmQsIHRyeSBucG0gaW5zdGFsbCBlbGFzdGljc2VhcmNoJykpO1xuICAgIH1cblxuICAgIGNvbnN0IGNvbnRhY3RQb2ludHMgPSB0aGlzLl9jb25uZWN0aW9uLmNvbnRhY3RQb2ludHM7XG4gICAgY29uc3QgZGVmYXVsdEhvc3RzID0gW107XG4gICAgY29udGFjdFBvaW50cy5mb3JFYWNoKChob3N0KSA9PiB7XG4gICAgICBkZWZhdWx0SG9zdHMucHVzaCh7IGhvc3QgfSk7XG4gICAgfSk7XG5cbiAgICBjb25zdCBlc0NsaWVudENvbmZpZyA9IF8uZGVmYXVsdHModGhpcy5fY29ubmVjdGlvbi5lbGFzdGljc2VhcmNoLCB7XG4gICAgICBob3N0czogZGVmYXVsdEhvc3RzLFxuICAgICAgc25pZmZPblN0YXJ0OiB0cnVlLFxuICAgIH0pO1xuICAgIHRoaXMuX2VzY2xpZW50ID0gbmV3IGVsYXN0aWNzZWFyY2guQ2xpZW50KGVzQ2xpZW50Q29uZmlnKTtcbiAgICByZXR1cm4gdGhpcy5fZXNjbGllbnQ7XG4gIH0sXG5cbiAgX2Fzc2VydF9lc19pbmRleChjYWxsYmFjaykge1xuICAgIGNvbnN0IGVzQ2xpZW50ID0gdGhpcy5jcmVhdGVfZXNfY2xpZW50KCk7XG4gICAgY29uc3QgaW5kZXhOYW1lID0gdGhpcy5fa2V5c3BhY2U7XG5cbiAgICBjb25zdCBlbGFzc2FuZHJhQnVpbGRlciA9IG5ldyBFbGFzc2FuZHJhQnVpbGRlcihlc0NsaWVudCk7XG4gICAgZWxhc3NhbmRyYUJ1aWxkZXIuYXNzZXJ0X2luZGV4KGluZGV4TmFtZSwgaW5kZXhOYW1lLCBjYWxsYmFjayk7XG4gIH0sXG5cbiAgY3JlYXRlX2dyZW1saW5fY2xpZW50KCkge1xuICAgIGlmICghZ3JlbWxpbikge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcignQ29uZmlndXJlZCB0byB1c2UgamFudXMgZ3JhcGggc2VydmVyLCBidXQgZ3JlbWxpbiBtb2R1bGUgd2FzIG5vdCBmb3VuZCwgdHJ5IG5wbSBpbnN0YWxsIGdyZW1saW4nKSk7XG4gICAgfVxuXG4gICAgY29uc3QgY29udGFjdFBvaW50cyA9IHRoaXMuX2Nvbm5lY3Rpb24uY29udGFjdFBvaW50cztcbiAgICBjb25zdCBkZWZhdWx0SG9zdHMgPSBbXTtcbiAgICBjb250YWN0UG9pbnRzLmZvckVhY2goKGhvc3QpID0+IHtcbiAgICAgIGRlZmF1bHRIb3N0cy5wdXNoKHsgaG9zdCB9KTtcbiAgICB9KTtcblxuICAgIGNvbnN0IGdyZW1saW5Db25maWcgPSBfLmRlZmF1bHRzKHRoaXMuX2Nvbm5lY3Rpb24uZ3JlbWxpbiwge1xuICAgICAgaG9zdDogZGVmYXVsdEhvc3RzWzBdLFxuICAgICAgcG9ydDogODE4MixcbiAgICAgIG9wdGlvbnM6IHt9LFxuICAgIH0pO1xuICAgIHRoaXMuX2dyZW1saW5fY2xpZW50ID0gZ3JlbWxpbi5jcmVhdGVDbGllbnQoZ3JlbWxpbkNvbmZpZy5wb3J0LCBncmVtbGluQ29uZmlnLmhvc3QsIGdyZW1saW5Db25maWcub3B0aW9ucyk7XG4gICAgcmV0dXJuIHRoaXMuX2dyZW1saW5fY2xpZW50O1xuICB9LFxuXG4gIF9hc3NlcnRfZ3JlbWxpbl9ncmFwaChjYWxsYmFjaykge1xuICAgIGNvbnN0IGdyZW1saW5DbGllbnQgPSB0aGlzLmNyZWF0ZV9ncmVtbGluX2NsaWVudCgpO1xuICAgIGNvbnN0IGtleXNwYWNlTmFtZSA9IHRoaXMuX2tleXNwYWNlO1xuICAgIGNvbnN0IGdyYXBoTmFtZSA9IGAke2tleXNwYWNlTmFtZX1fZ3JhcGhgO1xuXG4gICAgY29uc3QgZ3JhcGhCdWlsZGVyID0gbmV3IEphbnVzR3JhcGhCdWlsZGVyKGdyZW1saW5DbGllbnQpO1xuICAgIGdyYXBoQnVpbGRlci5hc3NlcnRfZ3JhcGgoZ3JhcGhOYW1lLCBjYWxsYmFjayk7XG4gIH0sXG5cbiAgZ2V0X3N5c3RlbV9jbGllbnQoKSB7XG4gICAgY29uc3QgY29ubmVjdGlvbiA9IF8uY2xvbmVEZWVwKHRoaXMuX2Nvbm5lY3Rpb24pO1xuICAgIGRlbGV0ZSBjb25uZWN0aW9uLmtleXNwYWNlO1xuXG4gICAgcmV0dXJuIG5ldyBjcWwuQ2xpZW50KGNvbm5lY3Rpb24pO1xuICB9LFxuXG4gIGdldF9rZXlzcGFjZV9uYW1lKCkge1xuICAgIHJldHVybiB0aGlzLl9rZXlzcGFjZTtcbiAgfSxcblxuICBfYXNzZXJ0X2tleXNwYWNlKGNhbGxiYWNrKSB7XG4gICAgY29uc3QgY2xpZW50ID0gdGhpcy5nZXRfc3lzdGVtX2NsaWVudCgpO1xuICAgIGNvbnN0IGtleXNwYWNlTmFtZSA9IHRoaXMuX2tleXNwYWNlO1xuICAgIGNvbnN0IG9wdGlvbnMgPSB0aGlzLl9vcHRpb25zO1xuXG4gICAgY29uc3Qga2V5c3BhY2VCdWlsZGVyID0gbmV3IEtleXNwYWNlQnVpbGRlcihjbGllbnQpO1xuXG4gICAga2V5c3BhY2VCdWlsZGVyLmdldF9rZXlzcGFjZShrZXlzcGFjZU5hbWUsIChlcnIsIGtleXNwYWNlT2JqZWN0KSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgaWYgKCFrZXlzcGFjZU9iamVjdCkge1xuICAgICAgICBrZXlzcGFjZUJ1aWxkZXIuY3JlYXRlX2tleXNwYWNlKGtleXNwYWNlTmFtZSwgb3B0aW9ucy5kZWZhdWx0UmVwbGljYXRpb25TdHJhdGVneSwgY2FsbGJhY2spO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGRiUmVwbGljYXRpb24gPSBub3JtYWxpemVyLm5vcm1hbGl6ZV9yZXBsaWNhdGlvbl9vcHRpb24oa2V5c3BhY2VPYmplY3QucmVwbGljYXRpb24pO1xuICAgICAgY29uc3Qgb3JtUmVwbGljYXRpb24gPSBub3JtYWxpemVyLm5vcm1hbGl6ZV9yZXBsaWNhdGlvbl9vcHRpb24ob3B0aW9ucy5kZWZhdWx0UmVwbGljYXRpb25TdHJhdGVneSk7XG5cbiAgICAgIGlmICghXy5pc0VxdWFsKGRiUmVwbGljYXRpb24sIG9ybVJlcGxpY2F0aW9uKSkge1xuICAgICAgICBrZXlzcGFjZUJ1aWxkZXIuYWx0ZXJfa2V5c3BhY2Uoa2V5c3BhY2VOYW1lLCBvcHRpb25zLmRlZmF1bHRSZXBsaWNhdGlvblN0cmF0ZWd5LCBjYWxsYmFjayk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY2xpZW50LnNodXRkb3duKCgpID0+IHtcbiAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9LFxuXG4gIF9hc3NlcnRfdXNlcl9kZWZpbmVkX3R5cGVzKGNhbGxiYWNrKSB7XG4gICAgY29uc3QgY2xpZW50ID0gdGhpcy5fZGVmaW5lX2Nvbm5lY3Rpb247XG4gICAgY29uc3Qgb3B0aW9ucyA9IHRoaXMuX29wdGlvbnM7XG4gICAgY29uc3Qga2V5c3BhY2UgPSB0aGlzLl9rZXlzcGFjZTtcblxuICAgIGlmICghb3B0aW9ucy51ZHRzKSB7XG4gICAgICBjYWxsYmFjaygpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHVkdEJ1aWxkZXIgPSBuZXcgVWR0QnVpbGRlcihjbGllbnQpO1xuXG4gICAgUHJvbWlzZS5tYXBTZXJpZXMoT2JqZWN0LmtleXMob3B0aW9ucy51ZHRzKSwgKHVkdEtleSkgPT4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdWR0Q2FsbGJhY2sgPSAoZXJyKSA9PiB7XG4gICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICByZWplY3QoZXJyKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgfTtcbiAgICAgIHVkdEJ1aWxkZXIuZ2V0X3VkdCh1ZHRLZXksIGtleXNwYWNlLCAoZXJyLCB1ZHRPYmplY3QpID0+IHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIHVkdENhbGxiYWNrKGVycik7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF1ZHRPYmplY3QpIHtcbiAgICAgICAgICB1ZHRCdWlsZGVyLmNyZWF0ZV91ZHQodWR0S2V5LCBvcHRpb25zLnVkdHNbdWR0S2V5XSwgdWR0Q2FsbGJhY2spO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHVkdEtleXMgPSBPYmplY3Qua2V5cyhvcHRpb25zLnVkdHNbdWR0S2V5XSk7XG4gICAgICAgIGNvbnN0IHVkdFZhbHVlcyA9IF8ubWFwKF8udmFsdWVzKG9wdGlvbnMudWR0c1t1ZHRLZXldKSwgbm9ybWFsaXplci5ub3JtYWxpemVfdXNlcl9kZWZpbmVkX3R5cGUpO1xuICAgICAgICBjb25zdCBmaWVsZE5hbWVzID0gdWR0T2JqZWN0LmZpZWxkX25hbWVzO1xuICAgICAgICBjb25zdCBmaWVsZFR5cGVzID0gXy5tYXAodWR0T2JqZWN0LmZpZWxkX3R5cGVzLCBub3JtYWxpemVyLm5vcm1hbGl6ZV91c2VyX2RlZmluZWRfdHlwZSk7XG5cbiAgICAgICAgaWYgKF8uZGlmZmVyZW5jZSh1ZHRLZXlzLCBmaWVsZE5hbWVzKS5sZW5ndGggPT09IDAgJiYgXy5kaWZmZXJlbmNlKHVkdFZhbHVlcywgZmllbGRUeXBlcykubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgdWR0Q2FsbGJhY2soKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyAobmV3IEVycm9yKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICdVc2VyIGRlZmluZWQgdHlwZSBcIiVzXCIgYWxyZWFkeSBleGlzdHMgYnV0IGRvZXMgbm90IG1hdGNoIHRoZSB1ZHQgZGVmaW5pdGlvbi4gJyArXG4gICAgICAgICAgJ0NvbnNpZGVyIGFsdGVyaW5nIG9yIGRyb3BpbmcgdGhlIHR5cGUuJyxcbiAgICAgICAgICB1ZHRLZXksXG4gICAgICAgICkpKTtcbiAgICAgIH0pO1xuICAgIH0pKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICB9KTtcbiAgfSxcblxuICBfYXNzZXJ0X3VzZXJfZGVmaW5lZF9mdW5jdGlvbnMoY2FsbGJhY2spIHtcbiAgICBjb25zdCBjbGllbnQgPSB0aGlzLl9kZWZpbmVfY29ubmVjdGlvbjtcbiAgICBjb25zdCBvcHRpb25zID0gdGhpcy5fb3B0aW9ucztcbiAgICBjb25zdCBrZXlzcGFjZSA9IHRoaXMuX2tleXNwYWNlO1xuXG4gICAgaWYgKCFvcHRpb25zLnVkZnMpIHtcbiAgICAgIGNhbGxiYWNrKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgdWRmQnVpbGRlciA9IG5ldyBVZGZCdWlsZGVyKGNsaWVudCk7XG5cbiAgICBQcm9taXNlLm1hcFNlcmllcyhPYmplY3Qua2V5cyhvcHRpb25zLnVkZnMpLCAodWRmS2V5KSA9PiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB1ZGZDYWxsYmFjayA9IChlcnIpID0+IHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9O1xuXG4gICAgICB1ZGZCdWlsZGVyLnZhbGlkYXRlX2RlZmluaXRpb24odWRmS2V5LCBvcHRpb25zLnVkZnNbdWRmS2V5XSk7XG5cbiAgICAgIHVkZkJ1aWxkZXIuZ2V0X3VkZih1ZGZLZXksIGtleXNwYWNlLCAoZXJyLCB1ZGZPYmplY3QpID0+IHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIHVkZkNhbGxiYWNrKGVycik7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF1ZGZPYmplY3QpIHtcbiAgICAgICAgICB1ZGZCdWlsZGVyLmNyZWF0ZV91ZGYodWRmS2V5LCBvcHRpb25zLnVkZnNbdWRmS2V5XSwgdWRmQ2FsbGJhY2spO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHVkZkxhbmd1YWdlID0gb3B0aW9ucy51ZGZzW3VkZktleV0ubGFuZ3VhZ2U7XG4gICAgICAgIGNvbnN0IHJlc3VsdExhbmd1YWdlID0gdWRmT2JqZWN0Lmxhbmd1YWdlO1xuXG4gICAgICAgIGNvbnN0IHVkZkNvZGUgPSBvcHRpb25zLnVkZnNbdWRmS2V5XS5jb2RlO1xuICAgICAgICBjb25zdCByZXN1bHRDb2RlID0gdWRmT2JqZWN0LmJvZHk7XG5cbiAgICAgICAgY29uc3QgdWRmUmV0dXJuVHlwZSA9IG5vcm1hbGl6ZXIubm9ybWFsaXplX3VzZXJfZGVmaW5lZF90eXBlKG9wdGlvbnMudWRmc1t1ZGZLZXldLnJldHVyblR5cGUpO1xuICAgICAgICBjb25zdCByZXN1bHRSZXR1cm5UeXBlID0gbm9ybWFsaXplci5ub3JtYWxpemVfdXNlcl9kZWZpbmVkX3R5cGUodWRmT2JqZWN0LnJldHVybl90eXBlKTtcblxuICAgICAgICBjb25zdCB1ZGZJbnB1dHMgPSBvcHRpb25zLnVkZnNbdWRmS2V5XS5pbnB1dHMgPyBvcHRpb25zLnVkZnNbdWRmS2V5XS5pbnB1dHMgOiB7fTtcbiAgICAgICAgY29uc3QgdWRmSW5wdXRLZXlzID0gT2JqZWN0LmtleXModWRmSW5wdXRzKTtcbiAgICAgICAgY29uc3QgdWRmSW5wdXRWYWx1ZXMgPSBfLm1hcChfLnZhbHVlcyh1ZGZJbnB1dHMpLCBub3JtYWxpemVyLm5vcm1hbGl6ZV91c2VyX2RlZmluZWRfdHlwZSk7XG4gICAgICAgIGNvbnN0IHJlc3VsdEFyZ3VtZW50TmFtZXMgPSB1ZGZPYmplY3QuYXJndW1lbnRfbmFtZXM7XG4gICAgICAgIGNvbnN0IHJlc3VsdEFyZ3VtZW50VHlwZXMgPSBfLm1hcCh1ZGZPYmplY3QuYXJndW1lbnRfdHlwZXMsIG5vcm1hbGl6ZXIubm9ybWFsaXplX3VzZXJfZGVmaW5lZF90eXBlKTtcblxuICAgICAgICBpZiAodWRmTGFuZ3VhZ2UgPT09IHJlc3VsdExhbmd1YWdlICYmXG4gICAgICAgICAgdWRmQ29kZSA9PT0gcmVzdWx0Q29kZSAmJlxuICAgICAgICAgIHVkZlJldHVyblR5cGUgPT09IHJlc3VsdFJldHVyblR5cGUgJiZcbiAgICAgICAgICBfLmlzRXF1YWwodWRmSW5wdXRLZXlzLCByZXN1bHRBcmd1bWVudE5hbWVzKSAmJlxuICAgICAgICAgIF8uaXNFcXVhbCh1ZGZJbnB1dFZhbHVlcywgcmVzdWx0QXJndW1lbnRUeXBlcykpIHtcbiAgICAgICAgICB1ZGZDYWxsYmFjaygpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHVkZkJ1aWxkZXIuY3JlYXRlX3VkZih1ZGZLZXksIG9wdGlvbnMudWRmc1t1ZGZLZXldLCB1ZGZDYWxsYmFjayk7XG4gICAgICB9KTtcbiAgICB9KSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgfSk7XG4gIH0sXG5cbiAgX2Fzc2VydF91c2VyX2RlZmluZWRfYWdncmVnYXRlcyhjYWxsYmFjaykge1xuICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuX2RlZmluZV9jb25uZWN0aW9uO1xuICAgIGNvbnN0IG9wdGlvbnMgPSB0aGlzLl9vcHRpb25zO1xuICAgIGNvbnN0IGtleXNwYWNlID0gdGhpcy5fa2V5c3BhY2U7XG5cbiAgICBpZiAoIW9wdGlvbnMudWRhcykge1xuICAgICAgY2FsbGJhY2soKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCB1ZGFCdWlsZGVyID0gbmV3IFVkYUJ1aWxkZXIoY2xpZW50KTtcblxuICAgIFByb21pc2UubWFwU2VyaWVzKE9iamVjdC5rZXlzKG9wdGlvbnMudWRhcyksICh1ZGFLZXkpID0+IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHVkYUNhbGxiYWNrID0gKGVycikgPT4ge1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgcmVqZWN0KGVycik7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH07XG5cbiAgICAgIHVkYUJ1aWxkZXIudmFsaWRhdGVfZGVmaW5pdGlvbih1ZGFLZXksIG9wdGlvbnMudWRhc1t1ZGFLZXldKTtcblxuICAgICAgaWYgKCFvcHRpb25zLnVkYXNbdWRhS2V5XS5pbml0Y29uZCkge1xuICAgICAgICBvcHRpb25zLnVkYXNbdWRhS2V5XS5pbml0Y29uZCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIHVkYUJ1aWxkZXIuZ2V0X3VkYSh1ZGFLZXksIGtleXNwYWNlLCAoZXJyLCB1ZGFPYmplY3RzKSA9PiB7XG4gICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICB1ZGFDYWxsYmFjayhlcnIpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdWRhT2JqZWN0cykge1xuICAgICAgICAgIHVkYUJ1aWxkZXIuY3JlYXRlX3VkYSh1ZGFLZXksIG9wdGlvbnMudWRhc1t1ZGFLZXldLCB1ZGFDYWxsYmFjayk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgaW5wdXRUeXBlcyA9IF8ubWFwKG9wdGlvbnMudWRhc1t1ZGFLZXldLmlucHV0X3R5cGVzLCBub3JtYWxpemVyLm5vcm1hbGl6ZV91c2VyX2RlZmluZWRfdHlwZSk7XG4gICAgICAgIGNvbnN0IHNmdW5jID0gb3B0aW9ucy51ZGFzW3VkYUtleV0uc2Z1bmMudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgY29uc3Qgc3R5cGUgPSBub3JtYWxpemVyLm5vcm1hbGl6ZV91c2VyX2RlZmluZWRfdHlwZShvcHRpb25zLnVkYXNbdWRhS2V5XS5zdHlwZSk7XG4gICAgICAgIGNvbnN0IGZpbmFsZnVuYyA9IG9wdGlvbnMudWRhc1t1ZGFLZXldLmZpbmFsZnVuYyA/IG9wdGlvbnMudWRhc1t1ZGFLZXldLmZpbmFsZnVuYy50b0xvd2VyQ2FzZSgpIDogbnVsbDtcbiAgICAgICAgY29uc3QgaW5pdGNvbmQgPSBvcHRpb25zLnVkYXNbdWRhS2V5XS5pbml0Y29uZCA/IG9wdGlvbnMudWRhc1t1ZGFLZXldLmluaXRjb25kLnJlcGxhY2UoL1tcXHNdL2csICcnKSA6IG51bGw7XG5cbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCB1ZGFPYmplY3RzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgY29uc3QgcmVzdWx0QXJndW1lbnRUeXBlcyA9IF8ubWFwKHVkYU9iamVjdHNbaV0uYXJndW1lbnRfdHlwZXMsIG5vcm1hbGl6ZXIubm9ybWFsaXplX3VzZXJfZGVmaW5lZF90eXBlKTtcblxuICAgICAgICAgIGNvbnN0IHJlc3VsdFN0YXRlRnVuYyA9IHVkYU9iamVjdHNbaV0uc3RhdGVfZnVuYztcbiAgICAgICAgICBjb25zdCByZXN1bHRTdGF0ZVR5cGUgPSBub3JtYWxpemVyLm5vcm1hbGl6ZV91c2VyX2RlZmluZWRfdHlwZSh1ZGFPYmplY3RzW2ldLnN0YXRlX3R5cGUpO1xuICAgICAgICAgIGNvbnN0IHJlc3VsdEZpbmFsRnVuYyA9IHVkYU9iamVjdHNbaV0uZmluYWxfZnVuYztcbiAgICAgICAgICBjb25zdCByZXN1bHRJbml0Y29uZCA9IHVkYU9iamVjdHNbaV0uaW5pdGNvbmQgPyB1ZGFPYmplY3RzW2ldLmluaXRjb25kLnJlcGxhY2UoL1tcXHNdL2csICcnKSA6IG51bGw7XG5cbiAgICAgICAgICBpZiAoc2Z1bmMgPT09IHJlc3VsdFN0YXRlRnVuYyAmJlxuICAgICAgICAgICAgc3R5cGUgPT09IHJlc3VsdFN0YXRlVHlwZSAmJlxuICAgICAgICAgICAgZmluYWxmdW5jID09PSByZXN1bHRGaW5hbEZ1bmMgJiZcbiAgICAgICAgICAgIGluaXRjb25kID09PSByZXN1bHRJbml0Y29uZCAmJlxuICAgICAgICAgICAgXy5pc0VxdWFsKGlucHV0VHlwZXMsIHJlc3VsdEFyZ3VtZW50VHlwZXMpKSB7XG4gICAgICAgICAgICB1ZGFDYWxsYmFjaygpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICB1ZGFCdWlsZGVyLmNyZWF0ZV91ZGEodWRhS2V5LCBvcHRpb25zLnVkYXNbdWRhS2V5XSwgdWRhQ2FsbGJhY2spO1xuICAgICAgfSk7XG4gICAgfSkpXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnIpID0+IHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIH0pO1xuICB9LFxuXG4gIF9zZXRfY2xpZW50KGNsaWVudCkge1xuICAgIGNvbnN0IGRlZmluZUNvbm5lY3Rpb25PcHRpb25zID0gXy5jbG9uZURlZXAodGhpcy5fY29ubmVjdGlvbik7XG5cbiAgICB0aGlzLl9jbGllbnQgPSBjbGllbnQ7XG4gICAgdGhpcy5fZGVmaW5lX2Nvbm5lY3Rpb24gPSBuZXcgY3FsLkNsaWVudChkZWZpbmVDb25uZWN0aW9uT3B0aW9ucyk7XG5cbiAgICAvLyBSZXNldCBjb25uZWN0aW9ucyBvbiBhbGwgbW9kZWxzXG4gICAgT2JqZWN0LmtleXModGhpcy5fbW9kZWxzKS5mb3JFYWNoKChpKSA9PiB7XG4gICAgICB0aGlzLl9tb2RlbHNbaV0uX3Byb3BlcnRpZXMuY3FsID0gdGhpcy5fY2xpZW50O1xuICAgICAgdGhpcy5fbW9kZWxzW2ldLl9wcm9wZXJ0aWVzLmRlZmluZV9jb25uZWN0aW9uID0gdGhpcy5fZGVmaW5lX2Nvbm5lY3Rpb247XG4gICAgfSk7XG4gIH0sXG5cbiAgaW5pdChjYWxsYmFjaykge1xuICAgIGNvbnN0IG9uVXNlckRlZmluZWRBZ2dyZWdhdGVzID0gKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG1hbmFnZW1lbnRUYXNrcyA9IFtdO1xuICAgICAgaWYgKHRoaXMuX2tleXNwYWNlICYmIHRoaXMuX29wdGlvbnMubWFuYWdlRVNJbmRleCkge1xuICAgICAgICB0aGlzLmFzc2VydEVTSW5kZXhBc3luYyA9IFByb21pc2UucHJvbWlzaWZ5KHRoaXMuX2Fzc2VydF9lc19pbmRleCk7XG4gICAgICAgIG1hbmFnZW1lbnRUYXNrcy5wdXNoKHRoaXMuYXNzZXJ0RVNJbmRleEFzeW5jKCkpO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMuX2tleXNwYWNlICYmIHRoaXMuX29wdGlvbnMubWFuYWdlR3JhcGhzKSB7XG4gICAgICAgIHRoaXMuYXNzZXJ0R3JlbWxpbkdyYXBoQXN5bmMgPSBQcm9taXNlLnByb21pc2lmeSh0aGlzLl9hc3NlcnRfZ3JlbWxpbl9ncmFwaCk7XG4gICAgICAgIG1hbmFnZW1lbnRUYXNrcy5wdXNoKHRoaXMuYXNzZXJ0R3JlbWxpbkdyYXBoQXN5bmMoKSk7XG4gICAgICB9XG4gICAgICBQcm9taXNlLmFsbChtYW5hZ2VtZW50VGFza3MpXG4gICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICBjYWxsYmFjayhudWxsLCB0aGlzKTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlcnIxKSA9PiB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyMSk7XG4gICAgICAgIH0pO1xuICAgIH07XG5cbiAgICBjb25zdCBvblVzZXJEZWZpbmVkRnVuY3Rpb25zID0gZnVuY3Rpb24gZihlcnIpIHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgdGhpcy5fYXNzZXJ0X3VzZXJfZGVmaW5lZF9hZ2dyZWdhdGVzKG9uVXNlckRlZmluZWRBZ2dyZWdhdGVzLmJpbmQodGhpcykpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWR1ZGEnLCBlLm1lc3NhZ2UpKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgY29uc3Qgb25Vc2VyRGVmaW5lZFR5cGVzID0gZnVuY3Rpb24gZihlcnIpIHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgdGhpcy5fYXNzZXJ0X3VzZXJfZGVmaW5lZF9mdW5jdGlvbnMob25Vc2VyRGVmaW5lZEZ1bmN0aW9ucy5iaW5kKHRoaXMpKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnZhbGlkYXRvci5pbnZhbGlkdWRmJywgZS5tZXNzYWdlKSk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIGNvbnN0IG9uS2V5c3BhY2UgPSBmdW5jdGlvbiBmKGVycikge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aGlzLl9zZXRfY2xpZW50KG5ldyBjcWwuQ2xpZW50KHRoaXMuX2Nvbm5lY3Rpb24pKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHRoaXMuX2Fzc2VydF91c2VyX2RlZmluZWRfdHlwZXMob25Vc2VyRGVmaW5lZFR5cGVzLmJpbmQodGhpcykpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWR1ZHQnLCBlLm1lc3NhZ2UpKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgaWYgKHRoaXMuX2tleXNwYWNlICYmIHRoaXMuX29wdGlvbnMuY3JlYXRlS2V5c3BhY2UgIT09IGZhbHNlKSB7XG4gICAgICB0aGlzLl9hc3NlcnRfa2V5c3BhY2Uob25LZXlzcGFjZS5iaW5kKHRoaXMpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgb25LZXlzcGFjZS5jYWxsKHRoaXMpO1xuICAgIH1cbiAgfSxcblxuICBhZGRNb2RlbChtb2RlbE5hbWUsIG1vZGVsU2NoZW1hKSB7XG4gICAgaWYgKCFtb2RlbE5hbWUgfHwgdHlwZW9mIChtb2RlbE5hbWUpICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnZhbGlkYXRvci5pbnZhbGlkc2NoZW1hJywgJ01vZGVsIG5hbWUgbXVzdCBiZSBhIHZhbGlkIHN0cmluZycpKTtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgc2NoZW1lci52YWxpZGF0ZV9tb2RlbF9zY2hlbWEobW9kZWxTY2hlbWEpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHNjaGVtYScsIGUubWVzc2FnZSkpO1xuICAgIH1cblxuICAgIGlmIChtb2RlbFNjaGVtYS5vcHRpb25zICYmIG1vZGVsU2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcykge1xuICAgICAgY29uc3QgdGltZXN0YW1wT3B0aW9ucyA9IHtcbiAgICAgICAgY3JlYXRlZEF0OiBtb2RlbFNjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMuY3JlYXRlZEF0IHx8ICdjcmVhdGVkQXQnLFxuICAgICAgICB1cGRhdGVkQXQ6IG1vZGVsU2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy51cGRhdGVkQXQgfHwgJ3VwZGF0ZWRBdCcsXG4gICAgICB9O1xuICAgICAgbW9kZWxTY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzID0gdGltZXN0YW1wT3B0aW9ucztcblxuICAgICAgbW9kZWxTY2hlbWEuZmllbGRzW21vZGVsU2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy5jcmVhdGVkQXRdID0ge1xuICAgICAgICB0eXBlOiAndGltZXN0YW1wJyxcbiAgICAgICAgZGVmYXVsdDoge1xuICAgICAgICAgICRkYl9mdW5jdGlvbjogJ3RvVGltZXN0YW1wKG5vdygpKScsXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgICAgbW9kZWxTY2hlbWEuZmllbGRzW21vZGVsU2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy51cGRhdGVkQXRdID0ge1xuICAgICAgICB0eXBlOiAndGltZXN0YW1wJyxcbiAgICAgICAgZGVmYXVsdDoge1xuICAgICAgICAgICRkYl9mdW5jdGlvbjogJ3RvVGltZXN0YW1wKG5vdygpKScsXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH1cblxuICAgIGlmIChtb2RlbFNjaGVtYS5vcHRpb25zICYmIG1vZGVsU2NoZW1hLm9wdGlvbnMudmVyc2lvbnMpIHtcbiAgICAgIGNvbnN0IHZlcnNpb25PcHRpb25zID0ge1xuICAgICAgICBrZXk6IG1vZGVsU2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5IHx8ICdfX3YnLFxuICAgICAgfTtcbiAgICAgIG1vZGVsU2NoZW1hLm9wdGlvbnMudmVyc2lvbnMgPSB2ZXJzaW9uT3B0aW9ucztcblxuICAgICAgbW9kZWxTY2hlbWEuZmllbGRzW21vZGVsU2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5XSA9IHtcbiAgICAgICAgdHlwZTogJ3RpbWV1dWlkJyxcbiAgICAgICAgZGVmYXVsdDoge1xuICAgICAgICAgICRkYl9mdW5jdGlvbjogJ25vdygpJyxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3QgYmFzZVByb3BlcnRpZXMgPSB7XG4gICAgICBuYW1lOiBtb2RlbE5hbWUsXG4gICAgICBzY2hlbWE6IG1vZGVsU2NoZW1hLFxuICAgICAga2V5c3BhY2U6IHRoaXMuX2tleXNwYWNlLFxuICAgICAgZGVmaW5lX2Nvbm5lY3Rpb246IHRoaXMuX2RlZmluZV9jb25uZWN0aW9uLFxuICAgICAgY3FsOiB0aGlzLl9jbGllbnQsXG4gICAgICBlc2NsaWVudDogdGhpcy5fZXNjbGllbnQsXG4gICAgICBncmVtbGluX2NsaWVudDogdGhpcy5fZ3JlbWxpbl9jbGllbnQsXG4gICAgICBnZXRfY29uc3RydWN0b3I6IHRoaXMuZ2V0TW9kZWwuYmluZCh0aGlzLCBtb2RlbE5hbWUpLFxuICAgICAgaW5pdDogdGhpcy5pbml0LmJpbmQodGhpcyksXG4gICAgICBkcm9wVGFibGVPblNjaGVtYUNoYW5nZTogdGhpcy5fb3B0aW9ucy5kcm9wVGFibGVPblNjaGVtYUNoYW5nZSxcbiAgICAgIGNyZWF0ZVRhYmxlOiB0aGlzLl9vcHRpb25zLmNyZWF0ZVRhYmxlLFxuICAgICAgbWlncmF0aW9uOiB0aGlzLl9vcHRpb25zLm1pZ3JhdGlvbixcbiAgICAgIGRpc2FibGVUVFlDb25maXJtYXRpb246IHRoaXMuX29wdGlvbnMuZGlzYWJsZVRUWUNvbmZpcm1hdGlvbixcbiAgICB9O1xuXG4gICAgdGhpcy5fbW9kZWxzW21vZGVsTmFtZV0gPSB0aGlzLl9nZW5lcmF0ZV9tb2RlbChiYXNlUHJvcGVydGllcyk7XG4gICAgcmV0dXJuIHRoaXMuX21vZGVsc1ttb2RlbE5hbWVdO1xuICB9LFxuXG4gIGdldE1vZGVsKG1vZGVsTmFtZSkge1xuICAgIHJldHVybiB0aGlzLl9tb2RlbHNbbW9kZWxOYW1lXSB8fCBudWxsO1xuICB9LFxuXG4gIGNsb3NlKGNhbGxiYWNrKSB7XG4gICAgY2FsbGJhY2sgPSBjYWxsYmFjayB8fCBub29wO1xuXG4gICAgaWYgKHRoaXMub3JtLl9lc2NsaWVudCkge1xuICAgICAgdGhpcy5vcm0uX2VzY2xpZW50LmNsb3NlKCk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMub3JtLl9ncmVtbGluX2NsaWVudCAmJiB0aGlzLm9ybS5fZ3JlbWxpbl9jbGllbnQuY29ubmVjdGlvbiAmJiB0aGlzLm9ybS5fZ3JlbWxpbl9jbGllbnQuY29ubmVjdGlvbi53cykge1xuICAgICAgdGhpcy5vcm0uX2dyZW1saW5fY2xpZW50LmNvbm5lY3Rpb24ud3MuY2xvc2UoKTtcbiAgICB9XG5cbiAgICBjb25zdCBjbGllbnRzVG9TaHV0ZG93biA9IFtdO1xuICAgIGlmICh0aGlzLm9ybS5fY2xpZW50KSB7XG4gICAgICBjbGllbnRzVG9TaHV0ZG93bi5wdXNoKHRoaXMub3JtLl9jbGllbnQuc2h1dGRvd24oKSk7XG4gICAgfVxuICAgIGlmICh0aGlzLm9ybS5fZGVmaW5lX2Nvbm5lY3Rpb24pIHtcbiAgICAgIGNsaWVudHNUb1NodXRkb3duLnB1c2godGhpcy5vcm0uX2RlZmluZV9jb25uZWN0aW9uLnNodXRkb3duKCkpO1xuICAgIH1cblxuICAgIFByb21pc2UuYWxsKGNsaWVudHNUb1NodXRkb3duKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICB9KTtcbiAgfSxcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gQXBvbGxvO1xuIl19