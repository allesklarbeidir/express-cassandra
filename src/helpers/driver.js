const _ = require('lodash');

const Promise = require('bluebird');
let dseDriver;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, import/no-unresolved
  dseDriver = require('dse-driver');
} catch (e) {
  dseDriver = null;
}

const debug = require('debug')('express-cassandra');
const ExponentialReconnectionPolicy = require("cassandra-driver/lib/policies/reconnection").ExponentialReconnectionPolicy;
const cql = Promise.promisifyAll(dseDriver || require('cassandra-driver'));

const Driver = function f(properties) {
  this._properties = properties;

  this.reconnectionScheduler = new ExponentialReconnectionPolicy(100, 3000, true);

  this.currentReconnectionSchedule = this.reconnectionScheduler.newSchedule();
};

Driver.prototype = {

  start_new_reconnection_schedule(){
    this.currentReconnectionSchedule = this.reconnectionScheduler.newSchedule();
  },
  do_reconnect(callback, counter, error, delay){
    this._properties.cql = new cql.Client(this._properties.connection_options);
    this._properties.define_connection = new cql.Client(this._properties.connection_options);
    if(process.env.DEBUG === "true"){
      console.warn(`Reconnecting with ${JSON.stringify(delay)}ms delay the ${counter+1}th time because of following error: ${error}`);
    }
    callback(true, counter+1);
  },


  ensure_init(callback) {
    if (!this._properties.cql) {
      this._properties.init(callback);
    } else {
      callback();
    }
  },

  execute_definition_query(query, callback) {
    this.ensure_init((err) => {
      if (err) {
        callback(err);
        return;
      }
      debug('executing definition query: %s', query);
      const properties = this._properties;
      const conn = properties.define_connection;
      const doExecute = (fromReconnection, reconnectionCounter) => {
        conn.execute(query, [], { prepare: false, fetchSize: 0 }, (err1, res) => {
          if(err1 && (err1.name === "NoHostAvailableError" || (err1.name === "DriverError" && err1.message === "Socket was closed"))){
            const delay = this.currentReconnectionSchedule.next().value;
            setTimeout(() => this.do_reconnect(doExecute, reconnectionCounter || 0, err1, delay), delay);
          }
          else{
            if(fromReconnection){
              this.start_new_reconnection_schedule();
            }
            callback(err1, res);
          }
        });
      }
      doExecute();
    });
  },

  execute_query(query, params, options, callback) {
    if (arguments.length === 3) {
      callback = options;
      options = {};
    }

    const defaults = {
      prepare: true,
    };

    options = _.defaultsDeep(options, defaults);

    this.ensure_init((err) => {
      if (err) {
        callback(err);
        return;
      }
      debug('executing query: %s with params: %j', query, params);

      const doExecute = (fromReconnection, reconnectionCounter) => {
        this._properties.cql.execute(query, params, options, (err1, result) => {
          if (err1 && err1.code === 8704) {
            this.execute_definition_query(query, callback);
          }
          else if(err1 && (err1.name === "NoHostAvailableError" || (err1.name === "DriverError" && err1.message === "Socket was closed"))){
            const delay = this.currentReconnectionSchedule.next().value;
            setTimeout(() => this.do_reconnect(doExecute, reconnectionCounter || 0, err1, delay), delay);
          }
          else{
            if(fromReconnection){
              this.start_new_reconnection_schedule();
            }
            callback(err1, result);
          }
        });
      };
      doExecute();
    });
  },

  execute_batch(queries, options, callback) {
    if (arguments.length === 2) {
      callback = options;
      options = {};
    }

    const defaults = {
      prepare: true,
    };

    options = _.defaultsDeep(options, defaults);

    this.ensure_init((err) => {
      if (err) {
        callback(err);
        return;
      }
      debug('executing batch queries: %j', queries);

      const doExecute = (fromReconnection, reconnectionCounter ) => {
        this._properties.cql.batch(queries, options, (err1, res) => {
          if(err1 && (err1.name === "NoHostAvailableError" || (err1.name === "DriverError" && err1.message === "Socket was closed"))){
            const delay = this.currentReconnectionSchedule.next().value;
            setTimeout(() => this.do_reconnect(doExecute, reconnectionCounter || 0, err1, delay), delay);
          }
          else{
            if(fromReconnection){
              this.start_new_reconnection_schedule();
            }
            callback(err1, res);
          }
        });
      };
      doExecute();
    });
  },

  execute_eachRow(query, params, options, onReadable, callback) {
    this.ensure_init((err) => {
      if (err) {
        callback(err);
        return;
      }
      debug('executing eachRow query: %s with params: %j', query, params);
      const doExecute = (fromReconnection, reconnectionCounter ) => {
        this._properties.cql.eachRow(query, params, options, onReadable, (err1, res) => {
          if(err1 && (err1.name === "NoHostAvailableError" || (err1.name === "DriverError" && err1.message === "Socket was closed"))){
            const delay = this.currentReconnectionSchedule.next().value;
            setTimeout(() => this.do_reconnect(doExecute, reconnectionCounter || 0, err1, delay), delay);
          }
          else{
            if(fromReconnection){
              this.start_new_reconnection_schedule();
            }
            callback(err1, res)
          }
        });
      };
      doExecute();
    });
  },

  execute_stream(query, params, options, onReadable, callback) {
    this.ensure_init((err) => {
      if (err) {
        callback(err);
        return;
      }
      debug('executing stream query: %s with params: %j', query, params);
      const doExecute = (fromReconnection, reconnectionCounter ) => {
        this._properties.cql.stream(query, params, options).on('readable', onReadable).on('end', (err1, res) => {
          if(err1 && (err1.name === "NoHostAvailableError" || (err1.name === "DriverError" && err1.message === "Socket was closed"))){
            const delay = this.currentReconnectionSchedule.next().value;
            setTimeout(() => this.do_reconnect(doExecute, reconnectionCounter || 0, err1, delay), delay);
          }
          else{
            if(fromReconnection){
              this.start_new_reconnection_schedule();
            }
            callback(err1, res);
          }
        });
      };
      doExecute();
    });
  },
};

module.exports = Driver;
