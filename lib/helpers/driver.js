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
    if (true || process.env.DEBUG === "true") {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9oZWxwZXJzL2RyaXZlci5qcyJdLCJuYW1lcyI6WyJfIiwicmVxdWlyZSIsIlByb21pc2UiLCJkc2VEcml2ZXIiLCJlIiwiZGVidWciLCJFeHBvbmVudGlhbFJlY29ubmVjdGlvblBvbGljeSIsImNxbCIsInByb21pc2lmeUFsbCIsIkRyaXZlciIsImYiLCJwcm9wZXJ0aWVzIiwiX3Byb3BlcnRpZXMiLCJyZWNvbm5lY3Rpb25TY2hlZHVsZXIiLCJjdXJyZW50UmVjb25uZWN0aW9uU2NoZWR1bGUiLCJuZXdTY2hlZHVsZSIsInByb3RvdHlwZSIsInN0YXJ0X25ld19yZWNvbm5lY3Rpb25fc2NoZWR1bGUiLCJkb19yZWNvbm5lY3QiLCJjYWxsYmFjayIsImNvdW50ZXIiLCJlcnJvciIsImRlbGF5IiwiQ2xpZW50IiwiY29ubmVjdGlvbl9vcHRpb25zIiwiZGVmaW5lX2Nvbm5lY3Rpb24iLCJwcm9jZXNzIiwiZW52IiwiREVCVUciLCJjb25zb2xlIiwid2FybiIsIkpTT04iLCJzdHJpbmdpZnkiLCJlbnN1cmVfaW5pdCIsImluaXQiLCJleGVjdXRlX2RlZmluaXRpb25fcXVlcnkiLCJxdWVyeSIsImVyciIsImNvbm4iLCJkb0V4ZWN1dGUiLCJmcm9tUmVjb25uZWN0aW9uIiwicmVjb25uZWN0aW9uQ291bnRlciIsImV4ZWN1dGUiLCJwcmVwYXJlIiwiZmV0Y2hTaXplIiwiZXJyMSIsInJlcyIsIm5hbWUiLCJtZXNzYWdlIiwibmV4dCIsInZhbHVlIiwic2V0VGltZW91dCIsImV4ZWN1dGVfcXVlcnkiLCJwYXJhbXMiLCJvcHRpb25zIiwiYXJndW1lbnRzIiwibGVuZ3RoIiwiZGVmYXVsdHMiLCJkZWZhdWx0c0RlZXAiLCJyZXN1bHQiLCJjb2RlIiwiZXhlY3V0ZV9iYXRjaCIsInF1ZXJpZXMiLCJiYXRjaCIsImV4ZWN1dGVfZWFjaFJvdyIsIm9uUmVhZGFibGUiLCJlYWNoUm93IiwiZXhlY3V0ZV9zdHJlYW0iLCJzdHJlYW0iLCJvbiIsIm1v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QWpCLENBQXFCNkQsTUFBckIsQ0FBNEJoQyxLQUE1QixFQUFtQ2lCLE1BQW5DLEVBQTJDQyxPQUEzQyxFQUFvRGUsRUFBcEQsQ0FBdUQsVUFBdkQsRUFBbUVKLFVBQW5FLEVBQStFSSxFQUEvRSxDQUFrRixLQUFsRixFQUF5RixVQUFDeEIsSUFBRCxFQUFPQyxHQUFQLEVBQWU7QUFDdEcsY0FBR0QsU0FBU0EsS0FBS0UsSUFBTCxLQUFjLHNCQUFkLElBQXlDRixLQUFLRSxJQUFMLEtBQWMsYUFBZCxJQUErQkYsS0FBS0csT0FBTCxLQUFpQixtQkFBbEcsQ0FBSCxFQUEySDtBQUN6SCxnQkFBTTFCLFFBQVEsT0FBS1IsMkJBQUwsQ0FBaUNtQyxJQUFqQyxHQUF3Q0MsS0FBdEQ7QUFDQUMsdUJBQVc7QUFBQSxxQkFBTSxPQUFLakMsWUFBTCxDQUFrQnFCLFNBQWxCLEVBQTZCRSx1QkFBdUIsQ0FBcEQsRUFBdURJLElBQXZELEVBQTZEdkIsS0FBN0QsQ0FBTjtBQUFBLGFBQVgsRUFBc0ZBLEtBQXRGO0FBQ0QsV0FIRCxNQUlJO0FBQ0YsZ0JBQUdrQixnQkFBSCxFQUFvQjtBQUNsQixxQkFBS3ZCLCtCQUFMO0FBQ0Q7QUFDREUscUJBQVMwQixJQUFULEVBQWVDLEdBQWY7QUFDRDtBQUNGLFNBWEQ7QUFZRCxPQWJEO0FBY0FQO0FBQ0QsS0FyQkQ7QUFzQkQ7QUEvS2dCLENBQW5COztBQWtMQStCLE9BQU9DLE9BQVAsR0FBaUI5RCxNQUFqQiIsImZpbGUiOiJkcml2ZXIuanMiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCBfID0gcmVxdWlyZSgnbG9kYXNoJyk7XG5cbmNvbnN0IFByb21pc2UgPSByZXF1aXJlKCdibHVlYmlyZCcpO1xubGV0IGRzZURyaXZlcjtcbnRyeSB7XG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBpbXBvcnQvbm8tZXh0cmFuZW91cy1kZXBlbmRlbmNpZXMsIGltcG9ydC9uby11bnJlc29sdmVkXG4gIGRzZURyaXZlciA9IHJlcXVpcmUoJ2RzZS1kcml2ZXInKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZHNlRHJpdmVyID0gbnVsbDtcbn1cblxuY29uc3QgZGVidWcgPSByZXF1aXJlKCdkZWJ1ZycpKCdleHByZXNzLWNhc3NhbmRyYScpO1xuY29uc3QgRXhwb25lbnRpYWxSZWNvbm5lY3Rpb25Qb2xpY3kgPSByZXF1aXJlKFwiY2Fzc2FuZHJhLWRyaXZlci9saWIvcG9saWNpZXMvcmVjb25uZWN0aW9uXCIpLkV4cG9uZW50aWFsUmVjb25uZWN0aW9uUG9saWN5O1xuY29uc3QgY3FsID0gUHJvbWlzZS5wcm9taXNpZnlBbGwoZHNlRHJpdmVyIHx8IHJlcXVpcmUoJ2Nhc3NhbmRyYS1kcml2ZXInKSk7XG5cbmNvbnN0IERyaXZlciA9IGZ1bmN0aW9uIGYocHJvcGVydGllcykge1xuICB0aGlzLl9wcm9wZXJ0aWVzID0gcHJvcGVydGllcztcblxuICB0aGlzLnJlY29ubmVjdGlvblNjaGVkdWxlciA9IG5ldyBFeHBvbmVudGlhbFJlY29ubmVjdGlvblBvbGljeSgxMDAsIDMwMDAsIHRydWUpO1xuXG4gIHRoaXMuY3VycmVudFJlY29ubmVjdGlvblNjaGVkdWxlID0gdGhpcy5yZWNvbm5lY3Rpb25TY2hlZHVsZXIubmV3U2NoZWR1bGUoKTtcbn07XG5cbkRyaXZlci5wcm90b3R5cGUgPSB7XG5cbiAgc3RhcnRfbmV3X3JlY29ubmVjdGlvbl9zY2hlZHVsZSgpe1xuICAgIHRoaXMuY3VycmVudFJlY29ubmVjdGlvblNjaGVkdWxlID0gdGhpcy5yZWNvbm5lY3Rpb25TY2hlZHVsZXIubmV3U2NoZWR1bGUoKTtcbiAgfSxcbiAgZG9fcmVjb25uZWN0KGNhbGxiYWNrLCBjb3VudGVyLCBlcnJvciwgZGVsYXkpe1xuICAgIHRoaXMuX3Byb3BlcnRpZXMuY3FsID0gbmV3IGNxbC5DbGllbnQodGhpcy5fcHJvcGVydGllcy5jb25uZWN0aW9uX29wdGlvbnMpO1xuICAgIHRoaXMuX3Byb3BlcnRpZXMuZGVmaW5lX2Nvbm5lY3Rpb24gPSBuZXcgY3FsLkNsaWVudCh0aGlzLl9wcm9wZXJ0aWVzLmNvbm5lY3Rpb25fb3B0aW9ucyk7XG4gICAgaWYodHJ1ZSB8fCBwcm9jZXNzLmVudi5ERUJVRyA9PT0gXCJ0cnVlXCIpe1xuICAgICAgY29uc29sZS53YXJuKGBSZWNvbm5lY3Rpbmcgd2l0aCAke0pTT04uc3RyaW5naWZ5KGRlbGF5KX1tcyBkZWxheSB0aGUgJHtjb3VudGVyKzF9dGggdGltZSBiZWNhdXNlIG9mIGZvbGxvd2luZyBlcnJvcjogJHtlcnJvcn1gKTtcbiAgICB9XG4gICAgY2FsbGJhY2sodHJ1ZSwgY291bnRlcisxKTtcbiAgfSxcblxuXG4gIGVuc3VyZV9pbml0KGNhbGxiYWNrKSB7XG4gICAgaWYgKCF0aGlzLl9wcm9wZXJ0aWVzLmNxbCkge1xuICAgICAgdGhpcy5fcHJvcGVydGllcy5pbml0KGNhbGxiYWNrKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2FsbGJhY2soKTtcbiAgICB9XG4gIH0sXG5cbiAgZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KHF1ZXJ5LCBjYWxsYmFjaykge1xuICAgIHRoaXMuZW5zdXJlX2luaXQoKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBkZWJ1ZygnZXhlY3V0aW5nIGRlZmluaXRpb24gcXVlcnk6ICVzJywgcXVlcnkpO1xuICAgICAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gICAgICBjb25zdCBjb25uID0gcHJvcGVydGllcy5kZWZpbmVfY29ubmVjdGlvbjtcbiAgICAgIGNvbnN0IGRvRXhlY3V0ZSA9IChmcm9tUmVjb25uZWN0aW9uLCByZWNvbm5lY3Rpb25Db3VudGVyKSA9PiB7XG4gICAgICAgIGNvbm4uZXhlY3V0ZShxdWVyeSwgW10sIHsgcHJlcGFyZTogZmFsc2UsIGZldGNoU2l6ZTogMCB9LCAoZXJyMSwgcmVzKSA9PiB7XG4gICAgICAgICAgaWYoZXJyMSAmJiAoZXJyMS5uYW1lID09PSBcIk5vSG9zdEF2YWlsYWJsZUVycm9yXCIgfHwgKGVycjEubmFtZSA9PT0gXCJEcml2ZXJFcnJvclwiICYmIGVycjEubWVzc2FnZSA9PT0gXCJTb2NrZXQgd2FzIGNsb3NlZFwiKSkpe1xuICAgICAgICAgICAgY29uc3QgZGVsYXkgPSB0aGlzLmN1cnJlbnRSZWNvbm5lY3Rpb25TY2hlZHVsZS5uZXh0KCkudmFsdWU7XG4gICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHRoaXMuZG9fcmVjb25uZWN0KGRvRXhlY3V0ZSwgcmVjb25uZWN0aW9uQ291bnRlcsKgfHwgMCwgZXJyMSwgZGVsYXkpLCBkZWxheSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGVsc2V7XG4gICAgICAgICAgICBpZihmcm9tUmVjb25uZWN0aW9uKXtcbiAgICAgICAgICAgICAgdGhpcy5zdGFydF9uZXdfcmVjb25uZWN0aW9uX3NjaGVkdWxlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYWxsYmFjayhlcnIxLCByZXMpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBkb0V4ZWN1dGUoKTtcbiAgICB9KTtcbiAgfSxcblxuICBleGVjdXRlX3F1ZXJ5KHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDMpIHtcbiAgICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICAgIG9wdGlvbnMgPSB7fTtcbiAgICB9XG5cbiAgICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICAgIHByZXBhcmU6IHRydWUsXG4gICAgfTtcblxuICAgIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgICB0aGlzLmVuc3VyZV9pbml0KChlcnIpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgZGVidWcoJ2V4ZWN1dGluZyBxdWVyeTogJXMgd2l0aCBwYXJhbXM6ICVqJywgcXVlcnksIHBhcmFtcyk7XG5cbiAgICAgIGNvbnN0IGRvRXhlY3V0ZSA9IChmcm9tUmVjb25uZWN0aW9uLCByZWNvbm5lY3Rpb25Db3VudGVyKSA9PiB7XG4gICAgICAgIHRoaXMuX3Byb3BlcnRpZXMuY3FsLmV4ZWN1dGUocXVlcnksIHBhcmFtcywgb3B0aW9ucywgKGVycjEsIHJlc3VsdCkgPT4ge1xuICAgICAgICAgIGlmIChlcnIxICYmIGVycjEuY29kZSA9PT0gODcwNCkge1xuICAgICAgICAgICAgdGhpcy5leGVjdXRlX2RlZmluaXRpb25fcXVlcnkocXVlcnksIGNhbGxiYWNrKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZWxzZSBpZihlcnIxICYmIChlcnIxLm5hbWUgPT09IFwiTm9Ib3N0QXZhaWxhYmxlRXJyb3JcIiB8fCAoZXJyMS5uYW1lID09PSBcIkRyaXZlckVycm9yXCIgJiYgZXJyMS5tZXNzYWdlID09PSBcIlNvY2tldCB3YXMgY2xvc2VkXCIpKSl7XG4gICAgICAgICAgICBjb25zdCBkZWxheSA9IHRoaXMuY3VycmVudFJlY29ubmVjdGlvblNjaGVkdWxlLm5leHQoKS52YWx1ZTtcbiAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gdGhpcy5kb19yZWNvbm5lY3QoZG9FeGVjdXRlLCByZWNvbm5lY3Rpb25Db3VudGVywqB8fCAwLCBlcnIxLCBkZWxheSksIGRlbGF5KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZWxzZXtcbiAgICAgICAgICAgIGlmKGZyb21SZWNvbm5lY3Rpb24pe1xuICAgICAgICAgICAgICB0aGlzLnN0YXJ0X25ld19yZWNvbm5lY3Rpb25fc2NoZWR1bGUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhbGxiYWNrKGVycjEsIHJlc3VsdCk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgIH07XG4gICAgICBkb0V4ZWN1dGUoKTtcbiAgICB9KTtcbiAgfSxcblxuICBleGVjdXRlX2JhdGNoKHF1ZXJpZXMsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDIpIHtcbiAgICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICAgIG9wdGlvbnMgPSB7fTtcbiAgICB9XG5cbiAgICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICAgIHByZXBhcmU6IHRydWUsXG4gICAgfTtcblxuICAgIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgICB0aGlzLmVuc3VyZV9pbml0KChlcnIpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgZGVidWcoJ2V4ZWN1dGluZyBiYXRjaCBxdWVyaWVzOiAlaicsIHF1ZXJpZXMpO1xuXG4gICAgICBjb25zdCBkb0V4ZWN1dGUgPSAoZnJvbVJlY29ubmVjdGlvbiwgcmVjb25uZWN0aW9uQ291bnRlcsKgKSA9PiB7XG4gICAgICAgIHRoaXMuX3Byb3BlcnRpZXMuY3FsLmJhdGNoKHF1ZXJpZXMsIG9wdGlvbnMsIChlcnIxLCByZXMpID0+IHtcbiAgICAgICAgICBpZihlcnIxICYmIChlcnIxLm5hbWUgPT09IFwiTm9Ib3N0QXZhaWxhYmxlRXJyb3JcIiB8fCAoZXJyMS5uYW1lID09PSBcIkRyaXZlckVycm9yXCIgJiYgZXJyMS5tZXNzYWdlID09PSBcIlNvY2tldCB3YXMgY2xvc2VkXCIpKSl7XG4gICAgICAgICAgICBjb25zdCBkZWxheSA9IHRoaXMuY3VycmVudFJlY29ubmVjdGlvblNjaGVkdWxlLm5leHQoKS52YWx1ZTtcbiAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gdGhpcy5kb19yZWNvbm5lY3QoZG9FeGVjdXRlLCByZWNvbm5lY3Rpb25Db3VudGVywqB8fCAwLCBlcnIxLCBkZWxheSksIGRlbGF5KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZWxzZXtcbiAgICAgICAgICAgIGlmKGZyb21SZWNvbm5lY3Rpb24pe1xuICAgICAgICAgICAgICB0aGlzLnN0YXJ0X25ld19yZWNvbm5lY3Rpb25fc2NoZWR1bGUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhbGxiYWNrKGVycjEsIHJlcyk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgIH07XG4gICAgICBkb0V4ZWN1dGUoKTtcbiAgICB9KTtcbiAgfSxcblxuICBleGVjdXRlX2VhY2hSb3cocXVlcnksIHBhcmFtcywgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spIHtcbiAgICB0aGlzLmVuc3VyZV9pbml0KChlcnIpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgZGVidWcoJ2V4ZWN1dGluZyBlYWNoUm93IHF1ZXJ5OiAlcyB3aXRoIHBhcmFtczogJWonLCBxdWVyeSwgcGFyYW1zKTtcbiAgICAgIGNvbnN0IGRvRXhlY3V0ZSA9IChmcm9tUmVjb25uZWN0aW9uLCByZWNvbm5lY3Rpb25Db3VudGVywqApID0+IHtcbiAgICAgICAgdGhpcy5fcHJvcGVydGllcy5jcWwuZWFjaFJvdyhxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCAoZXJyMSwgcmVzKSA9PiB7XG4gICAgICAgICAgaWYoZXJyMSAmJiAoZXJyMS5uYW1lID09PSBcIk5vSG9zdEF2YWlsYWJsZUVycm9yXCIgfHwgKGVycjEubmFtZSA9PT0gXCJEcml2ZXJFcnJvclwiICYmIGVycjEubWVzc2FnZSA9PT0gXCJTb2NrZXQgd2FzIGNsb3NlZFwiKSkpe1xuICAgICAgICAgICAgY29uc3QgZGVsYXkgPSB0aGlzLmN1cnJlbnRSZWNvbm5lY3Rpb25TY2hlZHVsZS5uZXh0KCkudmFsdWU7XG4gICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHRoaXMuZG9fcmVjb25uZWN0KGRvRXhlY3V0ZSwgcmVjb25uZWN0aW9uQ291bnRlcsKgfHwgMCwgZXJyMSwgZGVsYXkpLCBkZWxheSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGVsc2V7XG4gICAgICAgICAgICBpZihmcm9tUmVjb25uZWN0aW9uKXtcbiAgICAgICAgICAgICAgdGhpcy5zdGFydF9uZXdfcmVjb25uZWN0aW9uX3NjaGVkdWxlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYWxsYmFjayhlcnIxLCByZXMpXG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgIH07XG4gICAgICBkb0V4ZWN1dGUoKTtcbiAgICB9KTtcbiAgfSxcblxuICBleGVjdXRlX3N0cmVhbShxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjaykge1xuICAgIHRoaXMuZW5zdXJlX2luaXQoKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBkZWJ1ZygnZXhlY3V0aW5nIHN0cmVhbSBxdWVyeTogJXMgd2l0aCBwYXJhbXM6ICVqJywgcXVlcnksIHBhcmFtcyk7XG4gICAgICBjb25zdCBkb0V4ZWN1dGUgPSAoZnJvbVJlY29ubmVjdGlvbiwgcmVjb25uZWN0aW9uQ291bnRlcsKgKSA9PiB7XG4gICAgICAgIHRoaXMuX3Byb3BlcnRpZXMuY3FsLnN0cmVhbShxdWVyeSwgcGFyYW1zLCBvcHRpb25zKS5vbigncmVhZGFibGUnLCBvblJlYWRhYmxlKS5vbignZW5kJywgKGVycjEsIHJlcykgPT4ge1xuICAgICAgICAgIGlmKGVycjEgJiYgKGVycjEubmFtZSA9PT0gXCJOb0hvc3RBdmFpbGFibGVFcnJvclwiIHx8IChlcnIxLm5hbWUgPT09IFwiRHJpdmVyRXJyb3JcIiAmJiBlcnIxLm1lc3NhZ2UgPT09IFwiU29ja2V0IHdhcyBjbG9zZWRcIikpKXtcbiAgICAgICAgICAgIGNvbnN0IGRlbGF5ID0gdGhpcy5jdXJyZW50UmVjb25uZWN0aW9uU2NoZWR1bGUubmV4dCgpLnZhbHVlO1xuICAgICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB0aGlzLmRvX3JlY29ubmVjdChkb0V4ZWN1dGUsIHJlY29ubmVjdGlvbkNvdW50ZXLCoHx8IDAsIGVycjEsIGRlbGF5KSwgZGVsYXkpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBlbHNle1xuICAgICAgICAgICAgaWYoZnJvbVJlY29ubmVjdGlvbil7XG4gICAgICAgICAgICAgIHRoaXMuc3RhcnRfbmV3X3JlY29ubmVjdGlvbl9zY2hlZHVsZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2FsbGJhY2soZXJyMSwgcmVzKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfTtcbiAgICAgIGRvRXhlY3V0ZSgpO1xuICAgIH0pO1xuICB9LFxufTtcblxubW9kdWxlLmV4cG9ydHMgPSBEcml2ZXI7XG4iXX0=