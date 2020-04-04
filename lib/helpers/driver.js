'use strict';

var _ = require('lodash');

var Promise = require('bluebird');
var dseDriver = void 0;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, import/no-unresolved
  dseDriver = require('dse-driver');
} catch (e) {
  dseDriver = null;
}

var debug = require('debug')('express-cassandra');
var ExponentialReconnectionPolicy = require("cassandra-driver/lib/policies/reconnection").ExponentialReconnectionPolicy;
var cql = Promise.promisifyAll(dseDriver || require('cassandra-driver'));

var Driver = function f(properties) {
  this._properties = properties;

  this.reconnectionScheduler = new ExponentialReconnectionPolicy(100, 3000, true);

  this.currentReconnectionSchedule = this.reconnectionScheduler.newSchedule();
};

Driver.prototype = {

  start_new_reconnection_schedule() {
    this.currentReconnectionSchedule = this.reconnectionScheduler.newSchedule();
  },
  do_reconnect(callback, counter, error, delay) {
    this._properties.cql = new cql.Client(this._properties.connection_options);
    this._properties.define_connection = new cql.Client(this._properties.connection_options);
    if (process.env.DEBUG === "true") {
      console.warn(`Reconnecting with ${JSON.stringify(delay)}ms delay the ${counter + 1}th time because of following error: ${error}`);
    }
    callback(true, counter + 1);
  },

  ensure_init(callback) {
    if (!this._properties.cql) {
      this._properties.init(callback);
    } else {
      callback();
    }
  },

  execute_definition_query(query, callback) {
    var _this = this;

    this.ensure_init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      debug('executing definition query: %s', query);
      var properties = _this._properties;
      var conn = properties.define_connection;
      var doExecute = function doExecute(fromReconnection, reconnectionCounter) {
        conn.execute(query, [], { prepare: false, fetchSize: 0 }, function (err1, res) {
          if (err1 && (err1.name === "NoHostAvailableError" || err1.name === "DriverError" && err1.message === "Socket was closed")) {
            var delay = _this.currentReconnectionSchedule.next().value;
            setTimeout(function () {
              return _this.do_reconnect(doExecute, reconnectionCounter || 0, err1, delay);
            }, delay);
          } else {
            if (fromReconnection) {
              _this.start_new_reconnection_schedule();
            }
            callback(err1, res);
          }
        });
      };
      doExecute();
    });
  },

  execute_query(query, params, options, callback) {
    var _this2 = this;

    if (arguments.length === 3) {
      callback = options;
      options = {};
    }

    var defaults = {
      prepare: true
    };

    options = _.defaultsDeep(options, defaults);

    this.ensure_init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      debug('executing query: %s with params: %j', query, params);

      var doExecute = function doExecute(fromReconnection, reconnectionCounter) {
        _this2._properties.cql.execute(query, params, options, function (err1, result) {
          if (err1 && err1.code === 8704) {
            _this2.execute_definition_query(query, callback);
          } else if (err1 && (err1.name === "NoHostAvailableError" || err1.name === "DriverError" && err1.message === "Socket was closed")) {
            var delay = _this2.currentReconnectionSchedule.next().value;
            setTimeout(function () {
              return _this2.do_reconnect(doExecute, reconnectionCounter || 0, err1, delay);
            }, delay);
          } else {
            if (fromReconnection) {
              _this2.start_new_reconnection_schedule();
            }
            callback(err1, result);
          }
        });
      };
      doExecute();
    });
  },

  execute_batch(queries, options, callback) {
    var _this3 = this;

    if (arguments.length === 2) {
      callback = options;
      options = {};
    }

    var defaults = {
      prepare: true
    };

    options = _.defaultsDeep(options, defaults);

    this.ensure_init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      debug('executing batch queries: %j', queries);

      var doExecute = function doExecute(fromReconnection, reconnectionCounter) {
        _this3._properties.cql.batch(queries, options, function (err1, res) {
          if (err1 && (err1.name === "NoHostAvailableError" || err1.name === "DriverError" && err1.message === "Socket was closed")) {
            var delay = _this3.currentReconnectionSchedule.next().value;
            setTimeout(function () {
              return _this3.do_reconnect(doExecute, reconnectionCounter || 0, err1, delay);
            }, delay);
          } else {
            if (fromReconnection) {
              _this3.start_new_reconnection_schedule();
            }
            callback(err1, res);
          }
        });
      };
      doExecute();
    });
  },

  execute_eachRow(query, params, options, onReadable, callback) {
    var _this4 = this;

    this.ensure_init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      debug('executing eachRow query: %s with params: %j', query, params);
      var doExecute = function doExecute(fromReconnection, reconnectionCounter) {
        _this4._properties.cql.eachRow(query, params, options, onReadable, function (err1, res) {
          if (err1 && (err1.name === "NoHostAvailableError" || err1.name === "DriverError" && err1.message === "Socket was closed")) {
            var delay = _this4.currentReconnectionSchedule.next().value;
            setTimeout(function () {
              return _this4.do_reconnect(doExecute, reconnectionCounter || 0, err1, delay);
            }, delay);
          } else {
            if (fromReconnection) {
              _this4.start_new_reconnection_schedule();
            }
            callback(err1, res);
          }
        });
      };
      doExecute();
    });
  },

  execute_stream(query, params, options, onReadable, callback) {
    var _this5 = this;

    this.ensure_init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      debug('executing stream query: %s with params: %j', query, params);
      var doExecute = function doExecute(fromReconnection, reconnectionCounter) {
        _this5._properties.cql.stream(query, params, options).on('readable', onReadable).on('end', function (err1, res) {
          if (err1 && (err1.name === "NoHostAvailableError" || err1.name === "DriverError" && err1.message === "Socket was closed")) {
            var delay = _this5.currentReconnectionSchedule.next().value;
            setTimeout(function () {
              return _this5.do_reconnect(doExecute, reconnectionCounter || 0, err1, delay);
            }, delay);
          } else {
            if (fromReconnection) {
              _this5.start_new_reconnection_schedule();
            }
            callback(err1, res);
          }
        });
      };
      doExecute();
    });
  }
};

module.exports = Driver;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9oZWxwZXJzL2RyaXZlci5qcyJdLCJuYW1lcyI6WyJfIiwicmVxdWlyZSIsIlByb21pc2UiLCJkc2VEcml2ZXIiLCJlIiwiZGVidWciLCJFeHBvbmVudGlhbFJlY29ubmVjdGlvblBvbGljeSIsImNxbCIsInByb21pc2lmeUFsbCIsIkRyaXZlciIsImYiLCJwcm9wZXJ0aWVzIiwiX3Byb3BlcnRpZXMiLCJyZWNvbm5lY3Rpb25TY2hlZHVsZXIiLCJjdXJyZW50UmVjb25uZWN0aW9uU2NoZWR1bGUiLCJuZXdTY2hlZHVsZSIsInByb3RvdHlwZSIsInN0YXJ0X25ld19yZWNvbm5lY3Rpb25fc2NoZWR1bGUiLCJkb19yZWNvbm5lY3QiLCJjYWxsYmFjayIsImNvdW50ZXIiLCJlcnJvciIsImRlbGF5IiwiQ2xpZW50IiwiY29ubmVjdGlvbl9vcHRpb25zIiwiZGVmaW5lX2Nvbm5lY3Rpb24iLCJwcm9jZXNzIiwiZW52IiwiREVCVUciLCJjb25zb2xlIiwid2FybiIsIkpTT04iLCJzdHJpbmdpZnkiLCJlbnN1cmVfaW5pdCIsImluaXQiLCJleGVjdXRlX2RlZmluaXRpb25fcXVlcnkiLCJxdWVyeSIsImVyciIsImNvbm4iLCJkb0V4ZWN1dGUiLCJmcm9tUmVjb25uZWN0aW9uIiwicmVjb25uZWN0aW9uQ291bnRlciIsImV4ZWN1dGUiLCJwcmVwYXJlIiwiZmV0Y2hTaXplIiwiZXJyMSIsInJlcyIsIm5hbWUiLCJtZXNzYWdlIiwibmV4dCIsInZhbHVlIiwic2V0VGltZW91dCIsImV4ZWN1dGVfcXVlcnkiLCJwYXJhbXMiLCJvcHRpb25zIiwiYXJndW1lbnRzIiwibGVuZ3RoIiwiZGVmYXVsdHMiLCJkZWZhdWx0c0RlZXAiLCJyZXN1bHQiLCJjb2RlIiwiZXhlY3V0ZV9iYXRjaCIsInF1ZXJpZXMiLCJiYXRjaCIsImV4ZWN1dGVfZWFjaFJvdyIsIm9uUmVhZGFibGUiLCJlYWNoUm93IiwiZXhlY3V0ZV9zdHJlYW0iLCJzdHJlYW0iLCJvbiIsIm1v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QUFxQjZELE1BQXJCLENBQTRCaEMsS0FBNUIsRUFBbUNpQixNQUFuQyxFQUEyQ0MsT0FBM0MsRUFBb0RlLEVBQXBELENBQXVELFVBQXZELEVBQW1FSixVQUFuRSxFQUErRUksRUFBL0UsQ0FBa0YsS0FBbEYsRUFBeUYsVUFBQ3hCLElBQUQsRUFBT0MsR0FBUCxFQUFlO0FBQ3RHLGNBQUdELFNBQVNBLEtBQUtFLElBQUwsS0FBYyxzQkFBZCxJQUF5Q0YsS0FBS0UsSUFBTCxLQUFjLGFBQWQsSUFBK0JGLEtBQUtHLE9BQUwsS0FBaUIsbUJBQWxHLENBQUgsRUFBMkg7QUFDekgsZ0JBQU0xQixRQUFRLE9BQUtSLDJCQUFMLENBQWlDbUMsSUFBakMsR0FBd0NDLEtBQXREO0FBQ0FDLHVCQUFXO0FBQUEscUJBQU0sT0FBS2pDLFlBQUwsQ0FBa0JxQixTQUFsQixFQUE2QkUsdUJBQXVCLENBQXBELEVBQXVESSxJQUF2RCxFQUE2RHZCLEtBQTdELENBQU47QUFBQSxhQUFYLEVBQXNGQSxLQUF0RjtBQUNELFdBSEQsTUFJSTtBQUNGLGdCQUFHa0IsZ0JBQUgsRUFBb0I7QUFDbEIscUJBQUt2QiwrQkFBTDtBQUNEO0FBQ0RFLHFCQUFTMEIsSUFBVCxFQUFlQyxHQUFmO0FBQ0Q7QUFDRixTQVhEO0FBWUQsT0FiRDtBQWNBUDtBQUNELEtBckJEO0FBc0JEO0FBL0tnQixDQUFuQjs7QUFrTEErQixPQUFPQyxPQUFQLEdBQWlCOUQsTUFBakIiLCJmaWxlIjoiZHJpdmVyLmpzIiwic291cmNlc0NvbnRlbnQiOlsiY29uc3QgXyA9IHJlcXVpcmUoJ2xvZGFzaCcpO1xuXG5jb25zdCBQcm9taXNlID0gcmVxdWlyZSgnYmx1ZWJpcmQnKTtcbmxldCBkc2VEcml2ZXI7XG50cnkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgaW1wb3J0L25vLWV4dHJhbmVvdXMtZGVwZW5kZW5jaWVzLCBpbXBvcnQvbm8tdW5yZXNvbHZlZFxuICBkc2VEcml2ZXIgPSByZXF1aXJlKCdkc2UtZHJpdmVyJyk7XG59IGNhdGNoIChlKSB7XG4gIGRzZURyaXZlciA9IG51bGw7XG59XG5cbmNvbnN0IGRlYnVnID0gcmVxdWlyZSgnZGVidWcnKSgnZXhwcmVzcy1jYXNzYW5kcmEnKTtcbmNvbnN0IEV4cG9uZW50aWFsUmVjb25uZWN0aW9uUG9saWN5ID0gcmVxdWlyZShcImNhc3NhbmRyYS1kcml2ZXIvbGliL3BvbGljaWVzL3JlY29ubmVjdGlvblwiKS5FeHBvbmVudGlhbFJlY29ubmVjdGlvblBvbGljeTtcbmNvbnN0IGNxbCA9IFByb21pc2UucHJvbWlzaWZ5QWxsKGRzZURyaXZlciB8fCByZXF1aXJlKCdjYXNzYW5kcmEtZHJpdmVyJykpO1xuXG5jb25zdCBEcml2ZXIgPSBmdW5jdGlvbiBmKHByb3BlcnRpZXMpIHtcbiAgdGhpcy5fcHJvcGVydGllcyA9IHByb3BlcnRpZXM7XG5cbiAgdGhpcy5yZWNvbm5lY3Rpb25TY2hlZHVsZXIgPSBuZXcgRXhwb25lbnRpYWxSZWNvbm5lY3Rpb25Qb2xpY3koMTAwLCAzMDAwLCB0cnVlKTtcblxuICB0aGlzLmN1cnJlbnRSZWNvbm5lY3Rpb25TY2hlZHVsZSA9IHRoaXMucmVjb25uZWN0aW9uU2NoZWR1bGVyLm5ld1NjaGVkdWxlKCk7XG59O1xuXG5Ecml2ZXIucHJvdG90eXBlID0ge1xuXG4gIHN0YXJ0X25ld19yZWNvbm5lY3Rpb25fc2NoZWR1bGUoKXtcbiAgICB0aGlzLmN1cnJlbnRSZWNvbm5lY3Rpb25TY2hlZHVsZSA9IHRoaXMucmVjb25uZWN0aW9uU2NoZWR1bGVyLm5ld1NjaGVkdWxlKCk7XG4gIH0sXG4gIGRvX3JlY29ubmVjdChjYWxsYmFjaywgY291bnRlciwgZXJyb3IsIGRlbGF5KXtcbiAgICB0aGlzLl9wcm9wZXJ0aWVzLmNxbCA9IG5ldyBjcWwuQ2xpZW50KHRoaXMuX3Byb3BlcnRpZXMuY29ubmVjdGlvbl9vcHRpb25zKTtcbiAgICB0aGlzLl9wcm9wZXJ0aWVzLmRlZmluZV9jb25uZWN0aW9uID0gbmV3IGNxbC5DbGllbnQodGhpcy5fcHJvcGVydGllcy5jb25uZWN0aW9uX29wdGlvbnMpO1xuICAgIGlmKHByb2Nlc3MuZW52LkRFQlVHID09PSBcInRydWVcIil7XG4gICAgICBjb25zb2xlLndhcm4oYFJlY29ubmVjdGluZyB3aXRoICR7SlNPTi5zdHJpbmdpZnkoZGVsYXkpfW1zIGRlbGF5IHRoZSAke2NvdW50ZXIrMX10aCB0aW1lIGJlY2F1c2Ugb2YgZm9sbG93aW5nIGVycm9yOiAke2Vycm9yfWApO1xuICAgIH1cbiAgICBjYWxsYmFjayh0cnVlLCBjb3VudGVyKzEpO1xuICB9LFxuXG5cbiAgZW5zdXJlX2luaXQoY2FsbGJhY2spIHtcbiAgICBpZiAoIXRoaXMuX3Byb3BlcnRpZXMuY3FsKSB7XG4gICAgICB0aGlzLl9wcm9wZXJ0aWVzLmluaXQoY2FsbGJhY2spO1xuICAgIH0gZWxzZSB7XG4gICAgICBjYWxsYmFjaygpO1xuICAgIH1cbiAgfSxcblxuICBleGVjdXRlX2RlZmluaXRpb25fcXVlcnkocXVlcnksIGNhbGxiYWNrKSB7XG4gICAgdGhpcy5lbnN1cmVfaW5pdCgoZXJyKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGRlYnVnKCdleGVjdXRpbmcgZGVmaW5pdGlvbiBxdWVyeTogJXMnLCBxdWVyeSk7XG4gICAgICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5fcHJvcGVydGllcztcbiAgICAgIGNvbnN0IGNvbm4gPSBwcm9wZXJ0aWVzLmRlZmluZV9jb25uZWN0aW9uO1xuICAgICAgY29uc3QgZG9FeGVjdXRlID0gKGZyb21SZWNvbm5lY3Rpb24sIHJlY29ubmVjdGlvbkNvdW50ZXIpID0+IHtcbiAgICAgICAgY29ubi5leGVjdXRlKHF1ZXJ5LCBbXSwgeyBwcmVwYXJlOiBmYWxzZSwgZmV0Y2hTaXplOiAwIH0sIChlcnIxLCByZXMpID0+IHtcbiAgICAgICAgICBpZihlcnIxICYmIChlcnIxLm5hbWUgPT09IFwiTm9Ib3N0QXZhaWxhYmxlRXJyb3JcIiB8fCAoZXJyMS5uYW1lID09PSBcIkRyaXZlckVycm9yXCIgJiYgZXJyMS5tZXNzYWdlID09PSBcIlNvY2tldCB3YXMgY2xvc2VkXCIpKSl7XG4gICAgICAgICAgICBjb25zdCBkZWxheSA9IHRoaXMuY3VycmVudFJlY29ubmVjdGlvblNjaGVkdWxlLm5leHQoKS52YWx1ZTtcbiAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gdGhpcy5kb19yZWNvbm5lY3QoZG9FeGVjdXRlLCByZWNvbm5lY3Rpb25Db3VudGVywqB8fCAwLCBlcnIxLCBkZWxheSksIGRlbGF5KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZWxzZXtcbiAgICAgICAgICAgIGlmKGZyb21SZWNvbm5lY3Rpb24pe1xuICAgICAgICAgICAgICB0aGlzLnN0YXJ0X25ld19yZWNvbm5lY3Rpb25fc2NoZWR1bGUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhbGxiYWNrKGVycjEsIHJlcyk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIGRvRXhlY3V0ZSgpO1xuICAgIH0pO1xuICB9LFxuXG4gIGV4ZWN1dGVfcXVlcnkocXVlcnksIHBhcmFtcywgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMykge1xuICAgICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgICAgb3B0aW9ucyA9IHt9O1xuICAgIH1cblxuICAgIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgICAgcHJlcGFyZTogdHJ1ZSxcbiAgICB9O1xuXG4gICAgb3B0aW9ucyA9IF8uZGVmYXVsdHNEZWVwKG9wdGlvbnMsIGRlZmF1bHRzKTtcblxuICAgIHRoaXMuZW5zdXJlX2luaXQoKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBkZWJ1ZygnZXhlY3V0aW5nIHF1ZXJ5OiAlcyB3aXRoIHBhcmFtczogJWonLCBxdWVyeSwgcGFyYW1zKTtcblxuICAgICAgY29uc3QgZG9FeGVjdXRlID0gKGZyb21SZWNvbm5lY3Rpb24sIHJlY29ubmVjdGlvbkNvdW50ZXIpID0+IHtcbiAgICAgICAgdGhpcy5fcHJvcGVydGllcy5jcWwuZXhlY3V0ZShxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCAoZXJyMSwgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgaWYgKGVycjEgJiYgZXJyMS5jb2RlID09PSA4NzA0KSB7XG4gICAgICAgICAgICB0aGlzLmV4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShxdWVyeSwgY2FsbGJhY2spO1xuICAgICAgICAgIH1cbiAgICAgICAgICBlbHNlIGlmKGVycjEgJiYgKGVycjEubmFtZSA9PT0gXCJOb0hvc3RBdmFpbGFibGVFcnJvclwiIHx8IChlcnIxLm5hbWUgPT09IFwiRHJpdmVyRXJyb3JcIiAmJiBlcnIxLm1lc3NhZ2UgPT09IFwiU29ja2V0IHdhcyBjbG9zZWRcIikpKXtcbiAgICAgICAgICAgIGNvbnN0IGRlbGF5ID0gdGhpcy5jdXJyZW50UmVjb25uZWN0aW9uU2NoZWR1bGUubmV4dCgpLnZhbHVlO1xuICAgICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB0aGlzLmRvX3JlY29ubmVjdChkb0V4ZWN1dGUsIHJlY29ubmVjdGlvbkNvdW50ZXLCoHx8IDAsIGVycjEsIGRlbGF5KSwgZGVsYXkpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBlbHNle1xuICAgICAgICAgICAgaWYoZnJvbVJlY29ubmVjdGlvbil7XG4gICAgICAgICAgICAgIHRoaXMuc3RhcnRfbmV3X3JlY29ubmVjdGlvbl9zY2hlZHVsZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2FsbGJhY2soZXJyMSwgcmVzdWx0KTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfTtcbiAgICAgIGRvRXhlY3V0ZSgpO1xuICAgIH0pO1xuICB9LFxuXG4gIGV4ZWN1dGVfYmF0Y2gocXVlcmllcywgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMikge1xuICAgICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgICAgb3B0aW9ucyA9IHt9O1xuICAgIH1cblxuICAgIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgICAgcHJlcGFyZTogdHJ1ZSxcbiAgICB9O1xuXG4gICAgb3B0aW9ucyA9IF8uZGVmYXVsdHNEZWVwKG9wdGlvbnMsIGRlZmF1bHRzKTtcblxuICAgIHRoaXMuZW5zdXJlX2luaXQoKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBkZWJ1ZygnZXhlY3V0aW5nIGJhdGNoIHF1ZXJpZXM6ICVqJywgcXVlcmllcyk7XG5cbiAgICAgIGNvbnN0IGRvRXhlY3V0ZSA9IChmcm9tUmVjb25uZWN0aW9uLCByZWNvbm5lY3Rpb25Db3VudGVywqApID0+IHtcbiAgICAgICAgdGhpcy5fcHJvcGVydGllcy5jcWwuYmF0Y2gocXVlcmllcywgb3B0aW9ucywgKGVycjEsIHJlcykgPT4ge1xuICAgICAgICAgIGlmKGVycjEgJiYgKGVycjEubmFtZSA9PT0gXCJOb0hvc3RBdmFpbGFibGVFcnJvclwiIHx8IChlcnIxLm5hbWUgPT09IFwiRHJpdmVyRXJyb3JcIiAmJiBlcnIxLm1lc3NhZ2UgPT09IFwiU29ja2V0IHdhcyBjbG9zZWRcIikpKXtcbiAgICAgICAgICAgIGNvbnN0IGRlbGF5ID0gdGhpcy5jdXJyZW50UmVjb25uZWN0aW9uU2NoZWR1bGUubmV4dCgpLnZhbHVlO1xuICAgICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB0aGlzLmRvX3JlY29ubmVjdChkb0V4ZWN1dGUsIHJlY29ubmVjdGlvbkNvdW50ZXLCoHx8IDAsIGVycjEsIGRlbGF5KSwgZGVsYXkpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBlbHNle1xuICAgICAgICAgICAgaWYoZnJvbVJlY29ubmVjdGlvbil7XG4gICAgICAgICAgICAgIHRoaXMuc3RhcnRfbmV3X3JlY29ubmVjdGlvbl9zY2hlZHVsZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2FsbGJhY2soZXJyMSwgcmVzKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfTtcbiAgICAgIGRvRXhlY3V0ZSgpO1xuICAgIH0pO1xuICB9LFxuXG4gIGV4ZWN1dGVfZWFjaFJvdyhxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjaykge1xuICAgIHRoaXMuZW5zdXJlX2luaXQoKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBkZWJ1ZygnZXhlY3V0aW5nIGVhY2hSb3cgcXVlcnk6ICVzIHdpdGggcGFyYW1zOiAlaicsIHF1ZXJ5LCBwYXJhbXMpO1xuICAgICAgY29uc3QgZG9FeGVjdXRlID0gKGZyb21SZWNvbm5lY3Rpb24sIHJlY29ubmVjdGlvbkNvdW50ZXLCoCkgPT4ge1xuICAgICAgICB0aGlzLl9wcm9wZXJ0aWVzLmNxbC5lYWNoUm93KHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIChlcnIxLCByZXMpID0+IHtcbiAgICAgICAgICBpZihlcnIxICYmIChlcnIxLm5hbWUgPT09IFwiTm9Ib3N0QXZhaWxhYmxlRXJyb3JcIiB8fCAoZXJyMS5uYW1lID09PSBcIkRyaXZlckVycm9yXCIgJiYgZXJyMS5tZXNzYWdlID09PSBcIlNvY2tldCB3YXMgY2xvc2VkXCIpKSl7XG4gICAgICAgICAgICBjb25zdCBkZWxheSA9IHRoaXMuY3VycmVudFJlY29ubmVjdGlvblNjaGVkdWxlLm5leHQoKS52YWx1ZTtcbiAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gdGhpcy5kb19yZWNvbm5lY3QoZG9FeGVjdXRlLCByZWNvbm5lY3Rpb25Db3VudGVywqB8fCAwLCBlcnIxLCBkZWxheSksIGRlbGF5KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZWxzZXtcbiAgICAgICAgICAgIGlmKGZyb21SZWNvbm5lY3Rpb24pe1xuICAgICAgICAgICAgICB0aGlzLnN0YXJ0X25ld19yZWNvbm5lY3Rpb25fc2NoZWR1bGUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhbGxiYWNrKGVycjEsIHJlcylcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfTtcbiAgICAgIGRvRXhlY3V0ZSgpO1xuICAgIH0pO1xuICB9LFxuXG4gIGV4ZWN1dGVfc3RyZWFtKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gICAgdGhpcy5lbnN1cmVfaW5pdCgoZXJyKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGRlYnVnKCdleGVjdXRpbmcgc3RyZWFtIHF1ZXJ5OiAlcyB3aXRoIHBhcmFtczogJWonLCBxdWVyeSwgcGFyYW1zKTtcbiAgICAgIGNvbnN0IGRvRXhlY3V0ZSA9IChmcm9tUmVjb25uZWN0aW9uLCByZWNvbm5lY3Rpb25Db3VudGVywqApID0+IHtcbiAgICAgICAgdGhpcy5fcHJvcGVydGllcy5jcWwuc3RyZWFtKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMpLm9uKCdyZWFkYWJsZScsIG9uUmVhZGFibGUpLm9uKCdlbmQnLCAoZXJyMSwgcmVzKSA9PiB7XG4gICAgICAgICAgaWYoZXJyMSAmJiAoZXJyMS5uYW1lID09PSBcIk5vSG9zdEF2YWlsYWJsZUVycm9yXCIgfHwgKGVycjEubmFtZSA9PT0gXCJEcml2ZXJFcnJvclwiICYmIGVycjEubWVzc2FnZSA9PT0gXCJTb2NrZXQgd2FzIGNsb3NlZFwiKSkpe1xuICAgICAgICAgICAgY29uc3QgZGVsYXkgPSB0aGlzLmN1cnJlbnRSZWNvbm5lY3Rpb25TY2hlZHVsZS5uZXh0KCkudmFsdWU7XG4gICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHRoaXMuZG9fcmVjb25uZWN0KGRvRXhlY3V0ZSwgcmVjb25uZWN0aW9uQ291bnRlcsKgfHwgMCwgZXJyMSwgZGVsYXkpLCBkZWxheSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGVsc2V7XG4gICAgICAgICAgICBpZihmcm9tUmVjb25uZWN0aW9uKXtcbiAgICAgICAgICAgICAgdGhpcy5zdGFydF9uZXdfcmVjb25uZWN0aW9uX3NjaGVkdWxlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYWxsYmFjayhlcnIxLCByZXMpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9O1xuICAgICAgZG9FeGVjdXRlKCk7XG4gICAgfSk7XG4gIH0sXG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IERyaXZlcjtcbiJdfQ==