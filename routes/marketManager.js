var util = require('util');
var net = require('net');
var dict = require('dict');
var fs = require('fs');
var moment = require('moment');
var dictPath = require("path").join(__dirname, "dict");
var utils = require("./utils.js");
var Log = require('log');
var FixServer = require('nodefix').FixServer;
var CommonRuler = require('./ruler/common/common.js');

module.exports = MarketManager;

/*==================================================*/
/*====================MarketManager====================*/
/*==================================================*/
function MarketManager(market) {
    var self = this;
    var log = new Log('INFO');
    self.market = market;
    self.orders = [];
    self.trades = [];

    self.gateways = [];

    self.sessionOptions = dict();

    var startFixGateway = function(port, config, cb) {
        utils.getDictionary(config.spec, function(err, dictionary) {
            if (err) cb(err, null);
            else {
                var fixversion = config.fixversion;
                var options = config.options == undefined ? {} : JSON.parse(config.options);
                var accounts = config.accounts == undefined ? {} : JSON.parse(config.accounts);

                var server = new FixServer(port, fixversion, dictionary, options, accounts);
                server.createServer(function(session) {
                    if (session) {
                        session.on('outmsg', function(outmsg) {
                            var acct = outmsg.account;
                            var message = outmsg.message;
                            if (message['35'] == "0")
                                log.debug("- OUT\r\nPORT:"+port+"\r\nACCOUNT:"+acct+"\r\nMESSAGE:"+JSON.stringify(message)+"\r\n");
                            else
                                log.info("- OUT\r\nPORT:"+port+"\r\nACCOUNT:"+acct+"\r\nMESSAGE:"+JSON.stringify(message)+"\r\n");
                            var options = session.getOptions(acct);
                            if (options != undefined) {
                                self.sessionOptions.set(acct, options);
                            }
                        });

                        session.on('msg', function(msg) {
                            var acct = msg.account;
                            var message = msg.message;
                            if (message['35'] == "0")
                                log.debug("- IN\r\nPORT:"+port+"\r\nACCOUNT:"+acct+"\r\nMESSAGE:"+JSON.stringify(message)+"\r\n");
                            else
                                log.info("- IN\r\nPORT:"+port+"\r\nACCOUNT:"+acct+"\r\nMESSAGE:"+JSON.stringify(message)+"\r\n");
                            var options = session.getOptions(acct);
                            if (options != undefined) {
                                self.sessionOptions.set(acct, options);
                            }
                            self.ruler.process(message['35'], session, msg);
                        });

                        session.on('error', function(err) {
                            var acct = err.account;
                            var error = err.message;
                            log.error("\r\nPORT:"+port+"\r\nACCOUNT:"+acct+"\r\nERROR:"+error+"\r\n");
                        });

                        session.on('close', function(data) {
                            var acct = data.account;
                            log.info("\r\nPORT:"+port+"\r\nACCOUNT:"+acct+"\r\nCONNECTION CLOSED!\r\n");
                        });

                        session.on('logon', function(msg) {
                            var acct = msg.account;
                            log.info("\r\nPORT:"+port+"\r\nACCOUNT:"+acct+"\r\nLOGON!\r\n");
                            if (self.sessionOptions.has(acct)) {
                                var options = self.sessionOptions.get(acct);
                                if (options != undefined) {
                                    session.modifyBehavior(acct, { 'outgoingSeqNum': options.outgoingSeqNum });
                                }
                            } else {
                                self.sessionOptions.set(acct, null);
                            }
                        });
                        cb(session);
                    }
                });
            }
        })
    }

    var startGateway = function(config) {
        startFixGateway(config.port, config, function(server) {
            self.gateways.push(server);
        });
    }

    this.start = function(cb){
        self.ruler = new CommonRuler(self.market, log);

        self.market.gateways.forEach(function(gateway) {
            startGateway(gateway);
        });
        cb();
    }

    this.stop = function(cb) {
        self.gateways.forEach(function(gateway) {
            gateway.destroyConnection();
            setTimeout(function(){
                gateway = null;
            }, 1000)
        });

        setTimeout(function(){
            self.ruler.clearIntervals(function() {
                self.ruler = null;
            });
            cb();
        }, 2000)
    }

    this.send = function(gateway, client, message, cb) {
        var gateway_instance = self.gateways[gateway];
        if (gateway_instance) {
            gateway_instance.sendMsg(message, client, null, function(outmsg) {
                cb(outmsg);
            });
        }
    }
}
