var request = require('request');
var utils = require('../../utils.js');
var async = require('async');
var dict = require('dict');
var _ = require('underscore');
var template = require('./common.json');
var moment = require('moment-timezone');

module.exports = CommonRuler;

function CommonRuler(market, log) {
    var self = this;

    self.market = market;
    self.log = log;

    self.parties = market.parties == undefined ? {} : JSON.parse(market.parties);
    self.gateways = [];
    self.orders = [];
    self.tcrs = [];

    self.queue = [];

    // ******************************* Common *******************************
    var _findOrderById = function(id) {
        var results = self.orders.filter(function(o) { return o.data.OrderID == id});
        if (results.length == 1) {
            return results[0];
        } else {
            return null;
        }
    }

    var _updateData = function(obj, message) {
        for(key in message) {
            var ignore = false;
            if (message.hasOwnProperty(key)) {
                if (key == 'ExecutionInstruction') {
                    if ('ExecutionInstruction' in obj.data) {
                        ignore = true;
                    }
                }

                if(!ignore) {
                    obj.data[key] = message[key];
                }
            }
        }
    }

    var _build_onbook_parties = function(broker) {
        var parties = null;
        var f_parties = self.parties.filter(function(o) { return o.trader == broker});
        if (f_parties.length > 0) {
            var party = f_parties[0];
            parties = {
                "453": [
                    {
                        "448": party.trader,
                        "447": "D",
                        "452": "1"
                    },
                    {
                        "448": party.tradergroup,
                        "447": "D",
                        "452": "53"
                    },
                    {
                        "448": party.firm,
                        "447": "D",
                        "452": "76"
                    }
                ]
            }
        }

        return parties;
    }

    var _build_onbook_pt_parties = function(order) {
        var noSide = {
            "54": order.data.Side,
            "1427": order.data.ExecutionID,
            "1444": order.data.Side,
            "1115": "1",
            "37": order.data.OrderID,
            "11": order.data.ClientOrderID,
            "528": "A",
            "1": order.data.Account
        }
        var noPartyIDs = _build_onbook_parties(order.broker);
        var party = {
            "552": [
                _.extend({}, noSide, noPartyIDs)
            ]
        }
        return party;
    }

    var _send_native_message = function(message_template, order) {
        var session = order.session;
        var order_data = JSON.parse(JSON.stringify(order.data));
        var account = order.account;

        self.nQueue.push({
            session: session,
            account: account,
            data: order_data,
            message: JSON.parse(JSON.stringify(message_template)),
            status: 0
        });
    }

    var _send_dropcopy_message = function(message_template, order) {
        var broker = order.broker;
        var order_data = JSON.parse(JSON.stringify(order.data));
        var parties = _build_onbook_parties(broker);

        if (parties != undefined) {
            var message = _.extend({}, JSON.parse(JSON.stringify(message_template)), parties);
            var accounts = self.gateways.dropcopy.accounts.filter(function(o) { return o.brokerid == broker });
            if (accounts.length > 0) {
                accounts.forEach(function(acct) {
                    var account = acct.targetID;
                    self.dcQueue.push({
                        session: self.gateways.dropcopy,
                        account: account,
                        data: order_data,
                        message: message,
                        status: 0
                    });
                });
            }
        }
    }

    var _send_posttrade_message = function(message_template, account, data) {
        var qMsg = {
            session: self.gateways.posttrade,
            account: account,
            data: data,
            message: JSON.parse(JSON.stringify(message_template)),
            status: 0
        };
        self.ptQueue.push(qMsg);
    }

    var _send_onbook_posttrade_message = function(message_template, order) {
        var broker = order.broker;
        var order_data = JSON.parse(JSON.stringify(order.data));
        var parties = _build_onbook_pt_parties(order);

        if (parties != undefined) {
            var message = _.extend({}, message_template, parties);
            var accounts = self.gateways.posttrade.accounts.filter(function(o) { return o.brokerid == broker });
            if (accounts.length > 0) {
                accounts.forEach(function(acct) {
                    _send_posttrade_message(message, acct.targetID, order_data);
                });
            }
        }
    }

    var _send_offbook_posttrade_message = function(message_template, tcr, broker, isAcknowledge) {
        if (isAcknowledge) {
            _send_posttrade_message(message_template, tcr.account, tcr.data);
        } else {
            var accounts = self.gateways.posttrade.accounts.filter(function(o) { return o.brokerid == broker });
            if (accounts.length > 0) {
                accounts.forEach(function(acct) {
                    _send_posttrade_message(message_template, acct.targetID, tcr.data);
                });
            }
        }

    }
    // ***********************************************

    // ******************* Monitors ************************
    var send = function(msg, cb) {
        var session = msg.session;
        var account = msg.account;
        var data = msg.data;
        var message = msg.message;
        session.sendMsg(message, account, data, function(msg) {
            cb(msg);
        });
    }

    var monitor_queue = function() {
        return;
        // var messages = self.queue.filter(function(o) { return o.status == 0 });
        // if (messages.length > 0) {
        //     var message = messages[0];
        //     var client = self.gateways.dropcopy.clients.get(message.account);
        //     if (client == undefined) {
        //         message.status = 1; // Not be sent
        //     } else {
        //         var socket = client.socket;
        //         if (socket == undefined){
        //             message.status = 1; // Not be sent
        //         } else {
        //             message.status = 2; // Sent
        //             send(message, function(msg) {});
        //         }
        //     }
        // }
    }

    var timer_gateway = setInterval(monitor_queue, 50);

    // *****************************************************************

    // ************************* Order management ************************
    var getMarketPrice = function(code) {
        var insts = self.instruments.filter(function(o) { return o.exchangecode == code });
        if (insts.length > 0) {
            var instrument = insts[0];
            return instrument.price == undefined ? utils.randomDouble(1.0, 10.0) : parseFloat(instrument.price);
        } else {
            return null;
        }
    }

    var setMarketPrice = function(code, price) {
        var insts = self.instruments.filter(function(o) { return o.exchangecode == code });
        if (insts.length > 0) {
            var instrument = insts[0];
            instrument.price = price;
        }
    }

    var trading = function(order, isFully) {
        var msg_template = JSON.parse(JSON.stringify(template.native.execution_report));
        _send_native_message(msg_template, order);
        _send_onbook_posttrade_message(template.fix.pt_onbook_trade_capture_report, order);
        _send_dropcopy_message(template.fix.dc_execution_report, order);
    }

    var getContainer = function(order) {
        var container = null;

        if (order.TimeInForce == 50) {
            container = 21;
        } else {
            switch(order.OrderType) {
                case 1:
                    container = 3;
                    break;
                case 3:
                case 4:
                case 6:
                    container = 6;
                    break;
                case 50:
                case 51:
                    container = 20;
                    break;
                default:
                    container = 1;
                    break;
            }
        }

        return container;
    }

    var processNewOrder = function(session, message) {
        var account = message.account;
        var broker = session.accounts.filter(function(o) { return o.username == account})[0].brokerid;
        var status = "CREATE";

        var order = {
            session: session,
            account: account,
            status: status,
            broker: broker,
            data: {},
            trades: []
        };

        _updateData(order, message.message);
        order.data.CompID = account;
        order.data.ExecutionID = "E"+utils.randomString(null, 11);
        order.data.OrderID = "O"+utils.randomString(null, 11);
        order.data.TransactTime = (((new Date).getTime()) / 1000).toFixed(3).toString();
        order.data.CumQuantity = 0;
        order.data.LeavesQuantity = order.data.OrderQuantity;
        order.data.DisplayQuantity = order.data.OrderQuantity;
        order.data.OrderStatus = 0;
        order.data.Container = getContainer(order.data);
        order.data.ExecutionType = "0";
        order.data.OrderBook = 1;
        order.data.IsMarketOpsRequest = 0;
        order.data.ExecutionInstruction = 0;
        order.data.CrossID = order.data.CrossID == undefined ? '' : order.data.CrossID;

        self.orders.push(order);

        if (parseInt(order.data.OrderQuantity) > 999999999) {
            order.data.RejectCode = "009901" // Invalid value in field
            order.data.RejectReason = "Invalid value in field";
            rejectOrder(order, function() {});
            return;
        }

        if (parseFloat(order.data.LimitPrice) == 0.9001 ) {
            rejectAdmin(order.session, order.account, '009001', 'Unknown order book', order.data.MsgType, order.data.ClientOrderID, function() {});
            order.status = 'CLOSED';
            return;
        }

        if (order.data.OrderType == 2 && parseInt(order.data.LimitPrice) < 0.1) {
            order.data.RejectCode = "009901" // Invalid value in field
            order.data.RejectReason = "Invalid value in field";
            rejectOrder(order, function() {});
            return;
        }

        if (order.data.OrderType == 50 && parseInt(order.data.MinimumQuantity) == 0) {
            order.data.RejectCode = "001109" // Invalid Min Quantity (< zero)
            order.data.RejectReason = "Invalid Min Quantity (< zero)";
            rejectOrder(order, function() {});
            return;
        }

        if (order.data.SecurityID == '1003104') {
            rejectAdmin(order.session, order.account, '009001', 'Unknown order book', order.data.MsgType, order.data.ClientOrderID, function() {});
            order.status = 'CLOSED';
            return;
        }

        // Verify some TIF are not supported, and reject
        if (order.data.OrderType == 3 || order.data.OrderType == 4) {
            var invalidTIFForStopOrder = [5, 9, 51,10, 12]; //OPG, GFA, GFX ATC and CPX
            if (invalidTIFForStopOrder.indexOf(parseInt(order.data.TimeInForce)) >=0 ) {
                order.data.RejectCode = "001500" //Invalid TIF (unknown)
                rejectOrder(order, function() {});
                return;
            }
        }

        order.status = "CREATE";

        // Handle Market order as special one
        switch(order.data.OrderType) {
            case 1: //Market order
            case 5: // Market to Limit order
                processMarketOrder(order);
                break;
            default:
                _send_native_message(template.native.execution_report, order);
                _send_dropcopy_message(template.fix.dc_execution_report, order);

                if (order.data.OrderType == 2) { // Limit order
                    processLimitOrder(order);
                }
        }


    }

    var processAmendOrder = function(order) {
        if (order) {
            order.data.CompID = order.account;
            order.data.ExecutionID = "E"+utils.randomString(null, 7);
            order.data.TransactTime = (((new Date).getTime()) / 1000).toFixed(3).toString();
            order.data.LeavesQuantity = order.data.OrderQuantity;
            order.data.OrderStatus = 0;
            order.data.Container = getContainer(order.data);
            order.data.ExecutionType = "5";

            if (parseInt(order.data.OrderQuantity) > 999999999) {
                order.data.RejectCode = "009901" // Invalid value in field
                rejectOrder(order, function() {});
                return;
            }

            if (parseFloat(order.data.LimitPrice) == 0.9999 ) {
                rejectAdmin(order.session, order.account, '009999', 'System suspended', order.data.MsgType, order.data.ClientOrderID, function() {});
                order.status = 'CLOSED';
                return;
            }

            if (order.data.OrderType == 2 && parseFloat(order.data.LimitPrice) < 0.1) {
                order.data.RejectCode = "009901" // Invalid value in field
                rejectOrder(order, function() {});
                return;
            }

            order.status = "AMENDED";
            _send_native_message(template.native.execution_report, order);
            _send_dropcopy_message(template.fix.dc_execution_report, order);

            if (order.data.OrderType == 2 || (order.data.OrderType == 4 && order.data.Container == 1)) {
                processLimitOrder(order);
            }
        }
    }

    var processCancelOrder = function(order) {
        if (order) {
            order.data.CompID = order.account;
            order.data.ExecutionID = "E"+utils.randomString(null, 7);
            order.data.TransactTime = (((new Date).getTime()) / 1000).toFixed(3).toString();
            order.data.OrderStatus = 4;
            order.data.Container = 0;
            order.data.ExecutionType = "4";
            order.data.LeavesQuantity = 0;

            if (order.status == 'CLOSED') {
                order.data.RejectCode = "002000" //  Order not found (too late to cancel or unknown order)
                rejectOrder(order, function() {});
            } else {
                if (parseFloat(order.data.LimitPrice).toFixed(3) == 9.014 ) {
                    order.data.RejectCode = "009014" // Instrument in Pre-Trading session ER Matching Engine
                    rejectOrder(order, function() {});
                    return;
                }
                _send_native_message(template.native.execution_report, order);
                _send_dropcopy_message(template.fix.dc_execution_report, order);
                order.status = 'CLOSED';
            }
        }
    }

    var getMassCancelOrders = function(reqtype, broker, client, message) {
        var orders = [];

        switch(reqtype) {
            case 3: // All Firm orders for instrument
                var secid = message.message['SecurityID'];
                orders = self.orders.filter(function(o) { return o.status != "CLOSED" && o.broker == broker && o.data.SecurityID == secid });
                break;
            case 4: // All Firm orders for Segment
                var segment = message.message['Segment'];
                var sec_segment_f = self.instruments.filter(function(o) { return o.sourceexchange == segment });
                if (sec_segment_f.length > 0) {
                    orders = self.orders.filter(function(o) { return o.status != "CLOSED" && o.broker == broker && sec_segment_f.filter(function(s) { return s.exchangecode == o.data.SecurityID}).length > 0 });
                }
                break;
            case 7: // All orders for Client (Interface User ID)
                orders = self.orders.filter(function(o) { return o.status != "CLOSED" && o.account == client });
                break;
            case 8: // All orders for Firm
                orders = self.orders.filter(function(o) { return o.status != "CLOSED" && o.broker == broker });
                break;
            case 9: // Client (Interface User ID) orders for Instrument
                var secid = message.message['SecurityID'];
                orders = self.orders.filter(function(o) { return o.status != "CLOSED" && o.account == client && o.data.SecurityID == secid });
                break;
            case 14: // Client Interest for Underlying
                var secid_underlying = message.message['SecurityID'];
                var sec_underlying_f = self.instruments.filter(function(o) { return o.exchangecode == secid_underlying });
                if (sec_underlying_f.length > 0) {
                    var sec_underlying = sec_underlying_f[0].symbol;
                    var secs_with_underlying = self.instruments.filter(function(o) { return o.symbol.startsWith(sec_underlying) && o.symbol != secid_underlying });
                    if (secs_with_underlying.length > 0) {
                        var secs_udl = [];
                        secs_with_underlying.forEach(function(sec){
                            secs_udl.push(sec.exchangecode);
                        });
                        orders = self.orders.filter(function(o) { return o.status != "CLOSED" && o.account == client && secs_udl.filter(function(s) { return s == o.data.SecurityID}).length > 0 });
                    }
                }
                break;
            case 15: // Client (Interface User ID) orders for Segment
                var segment = message.message['Segment'];
                var sec_segment_f = self.instruments.filter(function(o) { return o.sourceexchange == segment });
                if (sec_segment_f.length > 0) {
                    orders = self.orders.filter(function(o) { return o.status != "CLOSED" && o.account == client && sec_segment_f.filter(function(s) { return s.exchangecode == o.data.SecurityID}).length > 0 });
                }
                break;
            case 22: //  Firm Interest for Underlying
                var secid_underlying = message.message['SecurityID'];
                var sec_underlying_f = self.instruments.filter(function(o) { return o.exchangecode == secid_underlying });
                if (sec_underlying_f.length > 0) {
                    var sec_underlying = sec_underlying_f[0].symbol;
                    var secs_with_underlying = self.instruments.filter(function(o) { return o.symbol.startsWith(sec_underlying) && o.symbol != secid_underlying });
                    if (secs_with_underlying.length > 0) {
                        var secs_udl = [];
                        secs_with_underlying.forEach(function(sec){
                            secs_udl.push(sec.exchangecode);
                        });
                        orders = self.orders.filter(function(o) { return o.status != "CLOSED" && o.broker == broker && secs_udl.filter(function(s) { return s == o.data.SecurityID}).length > 0 });
                    }
                }
                break;
        }

        return orders;
    }

    var processOrderMassCancel = function(session, message) {
        var client = message.account;
        var req_type = parseInt(message.message['MassCancelRequestType']);
        var order_book = parseInt(message.message['OrderBook']);
        var clordId = message.message['ClientOrderID'];
        var broker =  session.accounts.filter(function(o) { return o.username == client })[0].brokerid;
        if (order_book == 1) { // Regular
            var obj = {
                session: session,
                account: client,
                data: {
                    "ClientOrderID": clordId,
                    "OrderBook": order_book,
                    "Status": 7,
                    "RejectCode": '',
                    "TransactTime": (((new Date).getTime()) / 1000).toFixed(3).toString()
                }
            }

            _send_native_message(template.native.order_mass_cancel_report, obj);

            var orders = getMassCancelOrders(req_type, broker, client, message);
            orders.forEach(function(order) {
                processCancelOrder(order);
            })

        } else { // Negotiated Trades
            self.log.warning('Negotiated Trades mass cancel is not Implement yet!');
        }
    }

    var sendRecoveryMessages = function(session, account, messages, cb) {
        var i = 0;

        var messages = self.nQueue.filter(function(o) { return o.status == 1 });

        async.whilst(
            function () { return i < messages.length },
            function (next) {
                var message = messages[i];
                var client = self.gateways.orderentry.clients.get(message.account);
                if (client != undefined) {
                    var socket = client.socket;
                    if (socket != undefined){
                        message.status = 2; // Sent
                        send(message, function(msg) {});
                    }
                }
                i++;
                next();
            },
            function (err) {
                if (err) console.log(err);
                cb()
            }
        );
    }

    var processMissedMessage = function(session, message) {
        var seqno = message.message['SequenceNumber'];
        var partitionId = message.message['PartitionId'];
        var account = message.account;
        var data = {};

        if (partitionId == 1) {
            data.Status = 0;
        } else{
            data.Status = 2
        }
        var ackObj = {
            session: session,
            account: message.account,
            data: data
        }
        var tcObj = {
            session: session,
            account: message.account,
            data: data
        }
        _send_native_message(template.native.missed_messages, ackObj);
        if (data.Status == 0) {
            sendRecoveryMessages(session, account, session.outgoingMessages, function(){
                _send_native_message(template.native.transmission_complete, tcObj);
            });
        }
    }

    var processMarketOrder = function(order) {
        var match_order_side = parseInt(order.data.Side) == 1 ? 2: 1;
        var matchingOrders = self.orders.filter(function(o) {
            return o.status != 'CLOSED' &&
                    parseInt(o.data.Side) == match_order_side &&
                    o.data.SecurityID == order.data.SecurityID &&
                    o.data.ClientOrderID != order.data.ClientOrderID &&
                    (parseInt(o.data.OrderStatus) == 0 || parseInt(o.data.OrderStatus) == 1) &&
                    (parseInt(o.data.Container) == 1 || parseInt(o.data.Container) == 21)
        }).sort(function(a,b) {
            var ret = null;
            if (match_order_side == 1) {
                ret = a.data.LimitPrice < b.data.LimitPrice ? 1 : b.data.LimitPrice < a.data.LimitPrice ? -1 : 0;
            } else {
                ret = a.data.LimitPrice > b.data.LimitPrice ? 1 : b.data.LimitPrice > a.data.LimitPrice ? -1 : 0;
            }

            return ret;
        });
        if (matchingOrders.length > 0) {
            tradeOrders(order, matchingOrders, function(leavesqty) {
                if (leavesqty > 0) {
                    switch(order.data.OrderType) {
                        case 1: // Market order
                        case 3: // Stop order
                            expireOrder(order, function(){});
                            break;
                    }
                }
            });
        } else {
            if (order.data.OrderID == undefined) {
                order.data.OrderID = "O"+utils.randomString(null, 7);
            }
            switch(order.data.OrderType) {
                case 1: // Market Order
                case 3: // Stop order
                    expireOrder(order, function(){});
                    break;
            }
        }
    }

    var processLimitOrder = function(order) {
        var match_order_side = parseInt(order.data.Side) == 1 ? 2: 1;
        var matchingOrders = null;

        if (match_order_side == 1) {
            matchingOrders = self.orders.filter(function(o) {
                return o.status != 'CLOSED' &&
                parseInt(o.data.Side) == match_order_side &&
                o.data.SecurityID == order.data.SecurityID &&
                o.data.ClientOrderID != order.data.ClientOrderID &&
                (o.data.Container == 20 ? o.data.PeggedPrice : o.data.LimitPrice) >= order.data.LimitPrice &&
                (parseInt(o.data.OrderStatus) == 0 || parseInt(o.data.OrderStatus) == 1) &&
                (parseInt(o.data.Container) == 1 || parseInt(o.data.Container) == 21  || (parseInt(o.data.Container) == 20 && o.data.PeggedPrice != undefined))
            }).sort(function(a,b) {
                var a_price = a.data.Container == 20 ?  a.data.PeggedPrice : a.data.LimitPrice;
                var b_price = b.data.Container == 20 ?  b.data.PeggedPrice : b.data.LimitPrice;
                var ret = null;
                if (match_order_side == 1) {
                    ret = a_price < b_price ? 1 : b_price < a_price ? -1 : 0;
                } else {
                    ret = a_price > b_price ? 1 : b_price > a_price ? -1 : 0;
                }
                return ret;
            });
        } else {
            matchingOrders = self.orders.filter(function(o) {
                return o.status != 'CLOSED' &&
                parseInt(o.data.Side) == match_order_side &&
                o.data.SecurityID == order.data.SecurityID &&
                o.data.ClientOrderID != order.data.ClientOrderID &&
                (o.data.Container == 20 ? o.data.PeggedPrice : o.data.LimitPrice) <= order.data.LimitPrice &&
                (parseInt(o.data.OrderStatus) == 0 || parseInt(o.data.OrderStatus) == 1) &&
                (parseInt(o.data.Container) == 1 || parseInt(o.data.Container) == 21  || (parseInt(o.data.Container) == 20 && o.data.PeggedPrice != undefined))
            }).sort(function(a,b) {
                var a_price = a.data.Container == 20 ?  a.data.PeggedPrice : a.data.LimitPrice;
                var b_price = b.data.Container == 20 ?  b.data.PeggedPrice : b.data.LimitPrice;
                var ret = null;
                if (match_order_side == 1) {
                    ret = a_price < b_price ? 1 : b_price < a_price ? -1 : 0;
                } else {
                    ret = a_price > b_price ? 1 : b_price > a_price ? -1 : 0;
                }
                return ret;
            });
        }
        if (order.data.TimeInForce == 4) {//FOK
            matchingOrders = matchingOrders.filter(function(o) {
                return o.status != 'CLOSED' && o.data.OrderQuantity >= order.data.OrderQuantity;
            });
        }
        if (matchingOrders.length > 0) {
            tradeOrders(order, matchingOrders, function(leavesqty) {
                if (leavesqty > 0) {
                    if (order.data.TimeInForce == 3) { //IOC
                        expireOrder(order, function(){});
                    }
                }
            });
        } else {
            if (order.data.TimeInForce == 3 || order.data.TimeInForce == 4) { //IOC or FOK
                expireOrder(order, function() {});
            }
        }
    }

    var rejectAdmin = function(session, account, code, reason, type, crossID, cb) {
        var data = {
            "RejectCode": code,
            "RejectReason": reason,
            "MessageType": type,
            "ClientOrderID": crossID
        }

        session.sendMsg(template.native.admin_reject, account, data, function(data) {
            cb();
        });
    }

    var rejectOrder = function(order, cb) {
        order.data.ExecutionID = "E"+utils.randomString(null, 7);
        order.data.TransactTime = (((new Date).getTime()) / 1000).toFixed(3).toString();
        order.data.ExecutionType = "8";
        order.data.OrderStatus = 8;
        order.data.ExecutedPrice = "0.000000";
        order.data.ExecutedQuantity = 0;
        order.data.LeavesQuantity = 0;
        order.data.DisplayQuantity = 0;
        order.data.CumQuantity = 0;
        order.data.Container = 0;
        order.data.OrderID = '';
        _send_native_message(template.native.execution_report, order);
        _send_dropcopy_message(template.fix.dc_execution_report, order);
        order.status = "CLOSED";
    }

    var expireOrder = function(order, cb) {
        order.data.ExecutionID = "E"+utils.randomString(null, 7);
        order.data.TransactTime = (((new Date).getTime()) / 1000).toFixed(3).toString();
        order.data.OrderStatus = "C";
        order.data.ExecutionType = "C";
        order.data.Container = 0;
        order.data.ExecutedPrice = "0.000000";
        order.data.ExecutedQuantity = 0;
        order.data.LeavesQuantity = 0;
        order.data.DisplayQuantity = 0;
        order.data.CumQuantity = 0;
        order.data.Container = 0;
        order.status = "CLOSED";

        _send_native_message(template.native.execution_report, order);
        _send_dropcopy_message(template.fix.dc_execution_report, order);
    }

    var triggerStopOrder = function(order, cb) {
        var shouldTrigger = false;
        var securityCode = order.data.SecurityID.toString();
        var marketPrice = getMarketPrice(securityCode);

        if (marketPrice != undefined) {
            if (order.data.Side == 1) { // Buy order
                if (order.data.OrderType == 3 || order.data.OrderType == 4) { // Is Stop / Stop Limit order
                    if (parseFloat(order.data.StopPrice) <= marketPrice) shouldTrigger = true;
                } else { // Market If touched order
                    if (parseFloat(order.data.StopPrice) >= marketPrice) shouldTrigger = true;
                }
            } else { // Sell order
                if (order.data.OrderType == 3 || order.data.OrderType == 4) { // Is Stop / Stop Limit order
                    if (parseFloat(order.data.StopPrice) >= marketPrice) shouldTrigger = true;
                } else { // Market If touched order
                    if (parseFloat(order.data.StopPrice) <= marketPrice) shouldTrigger = true;
                }
            }
        }
        if (shouldTrigger) {
            order.data.ExecutionID = "E"+utils.randomString(null, 7);
            order.data.TransactTime = (((new Date).getTime()) / 1000).toFixed(3).toString();
            order.data.OrderStatus = 0;
            if (order.data.OrderType == 3)
                order.data.Container = 3;
            if (order.data.OrderType == 4 || order.data.OrderType == 6)
                order.data.Container = 1;
            order.data.ExecutionType = "L";
            order.data.ExecutedPrice = "0.000000";
            order.data.ExecutedQuantity = 0;
            order.status = "TRIGGERED";
            _send_native_message(template.native.execution_report, order);
            _send_dropcopy_message(template.fix.dc_execution_report, order);
            cb(order);
        } else {
            cb(null);
        }
    }

    var set_order_trade_data = function(order, ordStatus, execID, execPrice, execQty, leavesQty, cumQty, transactTime, tradeId, tradeRptId, tradeLinkId) {
        order.data.ExecutionID = execID;
        order.data.ExecutedPrice = execPrice;
        order.data.ExecutedQuantity = execQty;
        order.data.LeavesQuantity = leavesQty;
        order.data.CumQuantity = cumQty;
        order.data.TradeID = tradeId;
        order.data.TradeReportID = tradeRptId;
        order.data.TradeLinkID = tradeLinkId;
        order.data.TransactTime = transactTime;
        order.data.Container = 1;
        order.data.ExecutionType = "F";
        order.data.OrderStatus = ordStatus;
        order.data.TradeHandlingInstr = 0;
        order.data.TradeReportType = 0;
        order.data.TradeReportTransType = 0;
        order.data.MatchStatus = 0;
        order.data.TradeType = 0;
        order.data.TradeSubType = 1014;
        order.data.MatchType = 4;
        order.trades.push({
            execId: execID,
            tradeId: tradeId,
            tradeRptId: tradeRptId,
            tradeLinkId: order.data.TradeLinkID,
            tradePrice: order.data.ExecutedPrice,
            tradeQty: parseInt(order.data.ExecutedQuantity),
            transactTime: order.data.TransactTime
        });

        if (ordStatus == 2) {
            order.status = "CLOSED";
        }
    }

    var matchOrder = function(order, match_order, minQty) {
        var order_leavesQty = parseInt(order.data.LeavesQuantity);
        var match_order_leavesQty = match_order == undefined ? 0 : parseInt(match_order.data.LeavesQuantity);

        var tradeId = "T"+utils.randomString(null, 8);
        var tradeRptId = "L"+utils.randomString(null, 8);
        var tradeLinkId = "Z"+utils.randomString(null, 8);

        var transactTime = (((new Date).getTime()) / 1000).toFixed(3).toString();
        var execprice = match_order == undefined ? order.data.LimitPrice : (match_order.data.Container == 20 ? match_order.data.PeggedPrice : match_order.data.LimitPrice);
        setMarketPrice(order.data.SecurityID.toString(), execprice);

        var order_execId = "E"+utils.randomString(null, 7);
        var match_order_execId = "E"+utils.randomString(null, 7);

        if (order.data.OrderID == undefined) order.data.OrderID = "O"+utils.randomString(null, 7);

        if (match_order == undefined) {
            var order_execQty = minQty == undefined ? order_leavesQty : minQty;
            var order_cumQty = parseInt(order.data.CumQuantity == undefined ? 0 : order.data.CumQuantity) + order_execQty;
            var order_status = order_execQty == order_leavesQty ? 2 : 1;
            set_order_trade_data(order, order_status, order_execId, execprice, order_execQty, 0, order_cumQty, transactTime, tradeId, tradeRptId, tradeLinkId);
            trading(order);
        } else {
            var order_execQty = minQty == undefined ? (order_leavesQty > match_order_leavesQty ? match_order_leavesQty : order_leavesQty) : minQty;
            var match_order_execQty = minQty == undefined ? (match_order_leavesQty > order_leavesQty ? order_leavesQty : match_order_leavesQty) : minQty;

            var order_cumQty = parseInt(order.data.CumQuantity == undefined ? 0 : order.data.CumQuantity) + parseInt(order_execQty);
            var match_order_cumQty = parseInt(match_order.data.CumQuantity == undefined ? 0 : match_order.data.CumQuantity) + parseInt(match_order_execQty);

            set_order_trade_data(order, order_leavesQty - order_execQty == 0 ?  2 : 1, order_execId, execprice, order_execQty, order_leavesQty - order_execQty, order_cumQty, transactTime, tradeId, tradeRptId, tradeLinkId);
            set_order_trade_data(match_order, match_order_leavesQty - match_order_execQty == 0 ?  2 : 1, match_order_execId, execprice, match_order_execQty, match_order_leavesQty - match_order_execQty, match_order_cumQty, transactTime, tradeId, tradeRptId, tradeLinkId);

            trading(order);
            trading(match_order);
        }
    }

    var tradeOrders = function(order, matchingOrders, cb) {
        var i = 0;
        async.whilst(
            function () { return i < matchingOrders.length && parseInt(order.data.LeavesQuantity) > 0; },
            function (next) {
                var match_order = matchingOrders[i];
                // When the match order is a FillOrKill order and the leaves quantity does not fully match, it cannot be traded.
                if (parseInt(match_order.data.TimeInForce) == 4 && parseInt(match_order.data.LeavesQuantity) != parseInt(order.data.LeavesQuantity)) { // FOK
                    i++;
                    next();
                } else {
                    matchOrder(order, match_order);
                    i++;
                    next();
                }
            },
            function (err) {
                if (err) console.log(err);
                cb(parseInt(order.data.LeavesQuantity));
            }
        );
    }

    // Calculate price of Peg / Peg Limit orders
    var calculate_pegged_order_price = function(cb) {
        var peg_orders = self.orders.filter(function(o) { return o.status != 'CLOSED' && parseInt(o.data.Container) == 20 && (o.data.OrderStatus == 0 || o.data.OrderStatus == 1)});
        peg_orders.forEach(function(order) {
            var secid = order.data.SecurityID;
            var bestbid_price = 0;
            var bestoffer_price = 0;
            var buyOrders = self.orders.filter(function(o) {
                return o.data.SecurityID == secid &&
                    o.data.ClientOrderID != order.data.ClientOrderID &&
                    parseInt(o.data.Side) == 1 &&
                    (parseInt(o.data.Container) == 1 || parseInt(o.data.Container) == 21) &&
                    o.data.LimitPrice > 0 &&
                    (parseInt(o.data.OrderStatus) == 0 || parseInt(o.data.OrderStatus) == 1)
            }).sort(function(a,b) {return (a.data.LimitPrice < b.data.LimitPrice) ? 1 : ((b.data.LimitPrice < a.data.LimitPrice) ? -1 : 0);});
            if (buyOrders.length > 0) bestbid_price = buyOrders[0].data.LimitPrice;

            var sellOrders = self.orders.filter(function(o) {
                return o.data.SecurityID == secid &&
                    o.data.ClientOrderID != order.data.ClientOrderID &&
                    parseInt(o.data.Side) == 2 &&
                    (parseInt(o.data.Container) == 1 || parseInt(o.data.Container) == 21) &&
                    o.data.LimitPrice > 0 &&
                    (parseInt(o.data.OrderStatus) == 0 || parseInt(o.data.OrderStatus) == 1)
            }).sort(function(a,b) {return (a.data.LimitPrice > b.data.LimitPrice) ? 1 : ((b.data.LimitPrice > a.data.LimitPrice) ? -1 : 0);});
            if (sellOrders.length > 0) bestoffer_price = sellOrders[0].data.LimitPrice;

            if (bestbid_price > 0 && bestoffer_price > 0) {
                if (order.data.OrderType == 50) { // Pegged order
                    switch(order.data.OrderSubType) {
                        case 50: // Pegged to Mid
                            var midprice = parseFloat((bestbid_price+bestoffer_price) / 2);
                            order.data.PeggedPrice = midprice;
                            break;
                        case 51: // Pegged to Bid
                            order.data.PeggedPrice = parseFloat(bestbid_price) + 0.5
                            break;
                        case 52: // Pegged to Offer
                            order.data.PeggedPrice = parseFloat(bestoffer_price) - 0.5
                            break;
                    }
                } else { // Pegged Limit order
                    switch(order.data.OrderSubType) {
                        case 50: // Pegged to Mid
                            var midprice = parseFloat((bestbid_price+bestoffer_price) / 2);
                            if (order.data.Side == 1) { // when buy, mid price <= stop price
                                if (midprice <= order.data.StopPrice){
                                    order.data.PeggedPrice = midprice;
                                }
                            } else { // when sell, mid price >= stop price
                                if (midprice >= order.data.StopPrice){
                                    order.data.PeggedPrice = midprice;
                                }
                            }
                            break;
                        case 51: // Pegged to Bid
                            if (bestbid_price >= order.data.LimitPrice){ // when buy, bestbid > limit
                                order.data.PeggedPrice = parseFloat(bestbid_price) + 0.5
                            }
                            break;
                        case 52: // Pegged to Offer
                            if (bestoffer_price <= order.data.LimitPrice){ // when sell, bestbid < limit
                                order.data.PeggedPrice = parseFloat(bestoffer_price) - 0.5
                            }
                            break;
                    }
                }
            }
        });

        cb();
    }

    var respCreateCrossOrder = function(session, message, cb){
        var account = message.account;
        var broker = session.accounts.filter(function(o) { return o.username == account})[0].brokerid;
        var status = "CREATE";
        var msg = message.message;

        var new_buy_order = {
            session: session,
            account: account,
            status: status,
            broker: broker,
            data: {},
            trades: []
        };

        var new_sell_order = {
            session: session,
            account: account,
            status: status,
            broker: broker,
            data: {},
            trades: []
        };

        var tradeId = "T"+utils.randomString(null, 8);
        var tradeRptId = "L"+utils.randomString(null, 8);
        var tradeLinkId = "Z"+utils.randomString(null, 8);
        var orderID = "O"+utils.randomString(null, 7);

        new_buy_order.data.MsgType = msg.MsgType;
        new_buy_order.data.Side = 1;
        new_buy_order.data.OrderID = orderID + 'B';
        new_buy_order.data.CompID = account;
        new_buy_order.data.CrossID = msg.CrossID;
        new_buy_order.data.CrossType = msg.CrossType;
        new_buy_order.data.SecurityID = msg.SecurityID;
        new_buy_order.data.OrderType = msg.OrderType;
        new_buy_order.data.TimeInForce = msg.TimeInForce;
        new_buy_order.data.LimitPrice = msg.LimitPrice;
        new_buy_order.data.OrderQuantity = msg.OrderQuantity;
        new_buy_order.data.ClientOrderID = msg.BuySideClientOrderID;
        new_buy_order.data.Capacity = msg.BuySideCapacity;
        new_buy_order.data.TraderMnemonic = msg.BuySideTraderMnemonic;
        new_buy_order.data.Account = msg.BuySideAccount;
        new_buy_order.data.CrossID = msg.CrossID;
        new_buy_order.data.CrossType = msg.CrossType;

        new_sell_order.data.MsgType = msg.MsgType;
        new_sell_order.data.Side = 2;
        new_sell_order.data.OrderID = orderID + 'S';
        new_sell_order.data.CompID = account;
        new_sell_order.data.CrossID = msg.CrossID;
        new_sell_order.data.CrossType = msg.CrossType;
        new_sell_order.data.SecurityID = msg.SecurityID;
        new_sell_order.data.OrderType = msg.OrderType;
        new_sell_order.data.TimeInForce = msg.TimeInForce;
        new_sell_order.data.LimitPrice = msg.LimitPrice;
        new_sell_order.data.OrderQuantity = msg.OrderQuantity;
        new_sell_order.data.ClientOrderID = msg.SellSideClientOrderID;
        new_sell_order.data.Capacity = msg.SellSideCapacity;
        new_sell_order.data.TraderMnemonic = msg.SellSideTraderMnemonic;
        new_sell_order.data.Account = msg.SellSideAccount;
        new_sell_order.data.CrossID = msg.CrossID;
        new_sell_order.data.CrossType = msg.CrossType;

        var buy_party = self.parties.filter(function(o) { return o.trader == new_buy_order.broker && o.account == new_buy_order.data.Account });
        var sell_party = self.parties.filter(function(o) { return o.trader == new_sell_order.broker && o.account == new_sell_order.data.Account });

        if (buy_party.length  == 0 || sell_party.length == 0) {
            rejectAdmin(session, account, '134200', 'Unknown User', 'C', msg.CrossID, function() {});
        } else {
            var transactTime = (((new Date).getTime()) / 1000).toFixed(3).toString();

            set_order_trade_data(new_buy_order, 2, "E"+utils.randomString(null, 7), msg.LimitPrice, msg.OrderQuantity, 0, msg.OrderQuantity, transactTime, tradeId, tradeRptId, tradeLinkId);
            set_order_trade_data(new_sell_order, 2, "E"+utils.randomString(null, 7), msg.LimitPrice, msg.OrderQuantity, 0, msg.OrderQuantity, transactTime, tradeId, tradeRptId, tradeLinkId);

            trading(new_buy_order);
            trading(new_sell_order);
            cb();
        }
    }
    // **********************************************

    // ********************** TCR ***************************
    // *************** On Book ****************
    var processOnBookTrade = function(session, account, tcr_message) {
        var tradeReportType = tcr_message['856']; // Submit / Notify / Accept / Cancel / Withdraw / Cancel Withdraw / Decline
        var tradeReportTransType = tcr_message['487']; // New / Cancel / Replace

        // Cancel Trade
        if (tradeReportType == 6 && tradeReportTransType == 0) {
            var tradeid = tcr_message['1003'];
            var side = tcr_message['552'][0]['54'];

            var f_orders = self.orders.filter(function(o) { return o.trades.length > 0 && o.data.Side == side && o.trades.filter(function(p) { return p.tradeId == tradeid }).length > 0 });
            if (f_orders.length > 0) {
                var pt_message = JSON.parse(JSON.stringify(template.fix.pt_onbook_trade_capture_report));
                var order = f_orders[0];
                var trade = order.trades.filter(function(t) { return t.tradeId == tradeid })[0];
                var execId = "E"+utils.randomString(null, 7);
                pt_message['572'] =  order.data.TradeReportID;

                order.data.TradeReportID = 'L'+utils.randomString(null, 9);
                order.data.TradeReportType = tcr_message['856'];
                order.data.TradeReportTransType = tcr_message['487'];
                order.data.TradeExecutionID = order.data.ExecutionID;
                order.data.ExecutionID = execId;
                order.data.TransactTime = (((new Date).getTime()) / 1000).toFixed(3).toString();
                order.data.GrossTradeAmt = (parseInt(order.data.ExecutedQuantity) * parseFloat(order.data.ExecutedPrice)).toString();
                order.data.ExecutionType = "H";
                order.data.OrderStatus = "0";
                order.data.Container = 0;
                order.data.TradeType = 0;
                order.data.TradeReportTransType = 1;
                order.data.TradeReportStatus = 0;
                order.data.MatchStatus = 1;
                order.data.LeavesQuantity = parseInt(order.data.LeavesQuantity) + parseInt(trade.tradeQty);
                order.data.ExecutedQuantity = 0;
                order.data.ExecutionRefID = trade.execId;
                order.data.ExecutedQuantity = null;
                order.data.ExecutedPrice = null;
                order.data.SecondaryOrderID = null;

                order.trades.push({
                    execId: execId,
                    tradeId: order.data.TradeID,
                    tradeRptId: order.data.TradeReportID,
                    tradeLinkId: order.data.TradeLinkID,
                    tradePrice: order.data.ExecutedPrice,
                    tradeQty: (-1) * parseInt(order.data.ExecutedQuantity),
                    transactTime: order.data.TransactTime
                });
                order.status = "CLOSED";

                _send_onbook_posttrade_message(template.fix.pt_onbook_trade_capture_report_ack, order);
                _send_native_message(template.native.execution_report, order);
                _send_onbook_posttrade_message(pt_message, order);
                _send_dropcopy_message(template.fix.dc_execution_report, order);
            }
        }
    }
    // ***************************************

    // **************** Offbook ***************
    var processOffBookTrade = function(session, account, tcr_message) {
        var tradeType = tcr_message['1123']; // Single Party TCR  or Dual Party TCR
        var tradeReportType = tcr_message['856']; // Submit / Notify / Accept / Cancel / Withdraw / Cancel Withdraw / Decline
        var tradeReportTransType = tcr_message['487']; // New / Cancel / Replace

        // New TCR (Dual / Single)
        if (tradeReportType == 0 && tradeReportTransType == 0) {
            var tcr = {
                tradeType: tradeType,
                tradeReportType: tradeReportType,
                tradeReportTransType: tradeReportTransType,
                data: tcr_message,
                session: session,
                account: account
            }
            self.tcrs.push(tcr);

            if (tradeType == 1) { // Single party TCR
                newSinglePartyTCR(tcr);
            } else { // Dual party TCR
                newDualPartyTCR(tcr);
            }
        }

        // Cancel TCR (Dual / Single)
        if (tradeReportType == 6 && tradeReportTransType == 0) {
            var tradeid = tcr_message['1003'];
            var f_tcrs = self.tcrs.filter(function(o) { return o.tradeId == tradeid });
            if (f_tcrs.length > 0) {
                var tcr = f_tcrs[0];
                _updateData(tcr, tcr_message);
                tcr.session = session;
                tcr.account = account;
                if (tradeType == 1){ // Single party TCR
                    cancelSinglePartyTCR(tcr);
                } else { // Dual party TCR
                    cancelDualPartyTCR(tcr);
                }
            }
        }

        // Accept TCR  / Accept Cancel TCR (Dual)
        if (tradeReportType == 2 && tradeReportTransType == 2) {
            var tradeId = tcr_message['1003'];
            var f_tcrs = self.tcrs.filter(function(o) { return o.tradeId == tradeId });
            if (f_tcrs.length > 0) {
                var tcr = f_tcrs[0];
                _updateData(tcr, tcr_message);
                tcr.session = session;
                tcr.account = account;
                switch(tcr.status) {
                    case "NOTIFIED_CREATE":
                        acceptDualPartyTCR(tcr);
                        break;
                    case "NOTIFIED_CANCEL":
                        acceptCancelDualPartyTCR(tcr);
                        break;
                    case "WITHDRAW_CANCELLED":
                        rejectTCR(tcr, '7050', 'Cancellation process terminated');
                        break;
                    case "NOTIFIED_WITHDRAW":
                        rejectTCR(tcr, '7060', 'Request already accepted/declined');
                        break;
                }
            }
        }

        // Decline TCR / Reject Cancel TCR(Dual)
        if (tradeReportType == 3 && tradeReportTransType == 2) {
            var tradeId = tcr_message['1003'];
            var f_tcrs = self.tcrs.filter(function(o) { return o.tradeId == tradeId });
            if (f_tcrs.length > 0) {
                var tcr = f_tcrs[0];
                _updateData(tcr, tcr_message);
                tcr.session = session;
                tcr.account = account;
                if (tcr.status == "NOTIFIED_CANCEL") {
                    rejectCancelDualPartyTCR(tcr, function() {});
                } else {
                    declineDualPartyTCR(tcr, function() {});
                }
            }
        }

        // WithDraw TCR (Dual)
        if (tradeReportType == 0 && tradeReportTransType == 1) {
            var tradeId = tcr_message['1003'];
            var f_tcrs = self.tcrs.filter(function(o) { return o.tradeId == tradeId });
            if (f_tcrs.length > 0) {
                var tcr = f_tcrs[0];
                _updateData(tcr, tcr_message);
                tcr.session = session;
                tcr.account = account;
                withdrawDualPartyTCR(tcr, function() {});
            }
        }

        // WithDraw TCR cancellation (Dual)
        if (tradeReportType == 6 && tradeReportTransType == 1) {
            var tradeId = tcr_message['1003'];
            var f_tcrs = self.tcrs.filter(function(o) { return o.tradeId == tradeId });
            if (f_tcrs.length > 0) {
                var tcr = f_tcrs[0];
                _updateData(tcr, tcr_message);
                tcr.session = session;
                tcr.account = account;
                withdrawCancelDualPartyTCR(tcr, function() {});
            }
        }
    }
    var _build_single_party_tcr_parties = function(exec_party, counter_party) {
        var noPartyIDs = { "552" : [] };
        var exec = null;
        var counter = null;

        var exec_side = exec_party["54"];
        var counter_side = counter_party["54"];
        var exec_broker = exec_party['453'][0]['448'];
        var counter_broker = counter_party['453'][0]['448'];
        var exec_account = exec_party["1"];
        var counter_account = exec_party["1"];
        var exec_ordercapacity = exec_party["528"];
        var counter_ordercapacity = exec_party["528"];

        var e_party = self.parties.filter(function(o) { return o.trader == exec_broker });
        var c_party = self.parties.filter(function(o) { return o.trader == counter_broker });

        exec = {
            "54": exec_side,
            "453": [
                { "448": e_party[0].trader,  "447": "D", "452": 1 },
                { "448": e_party[0].tradergroup,  "447": "D", "452": 53 },
                { "448": e_party[0].firm,  "447": "D", "452": 76 },
            ],
            "1": exec_account,
            "528": exec_ordercapacity
        }

        counter = {
            "54": counter_side,
            "453": [
                { "448": c_party[0].trader,  "447": "D", "452": 17 },
                { "448": c_party[0].tradergroup,  "447": "D", "452": 37 },
                { "448": c_party[0].firm,  "447": "D", "452": 100 },
            ],
            "1": counter_account,
            "528": counter_ordercapacity
        }

        noPartyIDs["552"].push(exec);
        noPartyIDs["552"].push(counter);

        return noPartyIDs;
    }

    var _build_dual_party_tcr_parties = function(exec_party, counter_party, type) {
        var noPartyIDs = { "552" : [] };
        var exec = null;
        var oppo = null;

        var exec_side = exec_party["54"];
        var exec_broker = exec_party['453'][0]['448'];
        var exec_account = exec_party["1"];
        var exec_ordercapacity = exec_party["528"];
        var e_party = self.parties.filter(function(o) { return o.trader == exec_broker });

        var counter_side = counter_party["54"];
        var counter_broker = counter_party['453'][0]['448'];
        var counter_account = counter_party["1"];
        var counter_ordercapacity = counter_party["528"];
        var c_party = self.parties.filter(function(o) { return o.trader == counter_broker });

        switch(type) {
            case 1: // Notify
                exec = {
                    "54": exec_side,
                    "453": [
                        { "448": e_party[0].trader,  "447": "D", "452": 17 }
                    ]
                }

                counter = {
                    "54": counter_side,
                    "453": [
                        { "448": c_party[0].trader,  "447": "D", "452": 1 }
                    ]
                }
                noPartyIDs["552"].push(counter);
                noPartyIDs["552"].push(exec);

                break;
            default:
                exec = {
                    "54": exec_side,
                    "453": [
                        { "448": e_party[0].trader,  "447": "D", "452": 1 },
                        { "448": e_party[0].tradergroup,  "447": "D", "452": 53 },
                        { "448": e_party[0].firm,  "447": "D", "452": 76 },
                    ],
                    "1": exec_account,
                    "528": exec_ordercapacity
                }

                counter = {
                    "54": counter_side,
                    "453": [
                        { "448": c_party[0].trader,  "447": "D", "452": 17 }
                    ]
                }
                noPartyIDs["552"].push(exec);
                noPartyIDs["552"].push(counter);

                break;
        }


        return noPartyIDs;
    }

    // PartyRole, 1 - Exec, 17 - Counter
    var _find_party = function(sides, partyrole) {
        var party_side = null;
        sides.forEach(function(side) {
            var party_info = side['453'];
            var f_party = party_info.filter(function(o) { return o['452'] == partyrole});
            if (f_party.length > 0) {
                party_side = side;
                return;
            }
        })

        return party_side;
    }

    var _find_pt_sessions = function(broker) {
        var sessions = [];

        var accounts = self.gateways.posttrade.accounts.filter(function(o) { return o.brokerid == broker });
        if (accounts.length > 0) {
            accounts.forEach(function(acct) {
                var username = acct.targetID;
                if (self.gateways.posttrade.clients.has(username)) {
                    sessions.push({ session: self.gateways.posttrade, account: username });
                }
            });
        }
        return sessions;
    }

    function _isNumeric(n) {
      return !isNaN(parseFloat(n)) && isFinite(n);
    }

    var _attach_additional_tags = function(message, data, deleteTags) {
        var ignoreTags = ['8','9', '10', '35','1128','49','56','115','34','52'];

        for(key in data) {
            if (data.hasOwnProperty(key)) {
                if (typeof(data[key]) == "object" || ignoreTags.indexOf(key) >= 0 || !_isNumeric(key)) {
                    continue;
                } else {
                    if (!message.hasOwnProperty(key)) {
                        message[key] = data[key];
                    }
                }
            }
        }

        if (deleteTags != undefined) {
            deleteTags.forEach(function(tag){
                delete message[tag];
            })
        }
    }

    var _ack_tcr = function(tcr, template, matchStatus, deleteTags) {
        var parties = null;

        var tcr_data = tcr.data;
        var sides = tcr_data["552"];
        var exec_party = _find_party(sides, 1);
        var counter_party = _find_party(sides, 17);
        tcr.exec_broker = exec_party['453'][0]['448'];
        tcr.counter_broker  = counter_party['453'][0]['448'];

        if (tcr.tradeType == 1) { // Single party TCR
            parties = _build_single_party_tcr_parties(exec_party, counter_party);
        } else { // Dual Party TCR
            parties = _build_dual_party_tcr_parties(exec_party, counter_party, 0);
        }

        var message = _.extend({}, template, parties);
        _attach_additional_tags(message, tcr_data, deleteTags);
        message['573'] = matchStatus;
        _send_offbook_posttrade_message(message, tcr, tcr.exec_broker, true);
    }

    var _confirm_tcr = function(tcr, template, matchStatus, deleteTags) {
        var exec_parties = null;
        var counter_parties = null;

        var tcr_data = tcr.data;
        var sides = tcr_data["552"];
        var exec_party = _find_party(sides, 1);
        var counter_party = _find_party(sides, 17);

        if (tcr.tradeType == 1) { // Single party TCR
            exec_parties = _build_single_party_tcr_parties(exec_party, counter_party);
            counter_parties = _build_single_party_tcr_parties(counter_party, exec_party);
        } else { // Dual Party TCR
            exec_parties = _build_dual_party_tcr_parties(exec_party, counter_party, 0);
            counter_parties = _build_dual_party_tcr_parties(counter_party, exec_party, 0);
        }
        var exec_message = _.extend({}, template, exec_parties);
        exec_message["487"] = 2;
        exec_message["574"] = tcr.tradeType == 1 ? 2 : 1;
        _attach_additional_tags(exec_message, tcr_data, deleteTags);
        exec_message['573'] = matchStatus;
        exec_message['571'] = tcr_data.ExecTradeReportID;
        exec_message['572'] = tcr_data.RefExecTradeReportID;
        _send_offbook_posttrade_message(exec_message, tcr, tcr.exec_broker, false);

        var counter_message = _.extend({}, template, counter_parties);
        counter_message["487"] = tcr.tradeType == 1 ? 0 : 2;
        counter_message["574"] = tcr.tradeType == 1 ? 2 : 1;
        _attach_additional_tags(counter_message, tcr_data, deleteTags);
        counter_message['573'] = matchStatus;
        counter_message['571'] = tcr_data.CounterTradeReportID;
        counter_message['572'] = tcr_data.RefCounterTradeReportID;
        _send_offbook_posttrade_message(counter_message, tcr, tcr.counter_broker);
    }

    var _notify_tcr = function(tcr, template, deleteTags) {
        var tcr_data = tcr.data;
        var sides = tcr_data['552'];
        var exec_party = _find_party(sides, 1);
        var counter_party = _find_party(sides, 17);
        var exec_side = exec_party["54"];
        var counter_side = counter_party["54"];

        var parties = _build_dual_party_tcr_parties(exec_party, counter_party, 1);
        var notify_message = _.extend({}, template, parties);
        _attach_additional_tags(notify_message, tcr_data, deleteTags);
        _send_offbook_posttrade_message(notify_message, tcr, tcr.counter_broker, false);
    }

    // ************ Single Party ***************
    var newSinglePartyTCR = function(tcr) {
        if (parseInt(tcr.data["31"]) == 102) {
            var daydiff = moment().utc().isoWeekday() == 1 ? 3 : 1
            var origTradeTime =  moment().utc().subtract(daydiff, 'days').format("YYYYMMDD-HH:mm:ss");
            tcr.data["122"] = origTradeTime;
        }

        var securityId = tcr.data['48'];
        var settlDate = moment().utc().format("YYYYMMDD");
        var rndId = utils.randomString(null, 9);
        tcr.tradeId = "M"+rndId;
        tcr.tradeLinkId = "N"+rndId;
        tcr.data.TradeID = tcr.tradeId;
        tcr.data.TradeLinkID = tcr.tradeLinkId;
        if (tcr.data['64'] == undefined)
            tcr.data['64'] = settlDate;
        tcr.data['1390'] = 1;
        tcr.data.TradeReportStatus = 0;
        _ack_tcr(tcr, template.fix.pt_offbook_trade_capture_report_ack, 1, ['22']);

        tcr.data.ProductComplex = self.instruments.filter(function(o) { return o.exchangecode == securityId })[0].sourceexchange;
        tcr.data.ExecTradeReportID = 'L'+utils.randomString(null, 9);
        tcr.data.CounterTradeReportID = 'L'+utils.randomString(null, 9);
        tcr.data.ExecutionType = 'F';
        tcr.data.TradeReportType = 0;
        tcr.data.TradeReportTransType = 0;
        tcr.data.MatchType = 2;
        tcr.data.LastQty = tcr.data['32'];
        tcr.data.LastPx = tcr.data['31'];
        tcr.data.PriceType = 2;
        _confirm_tcr(tcr, template.fix.pt_offbook_trade_capture_report_trade, 0, ['22']);

        tcr.status = "TRADED";
    }

    var cancelSinglePartyTCR = function(tcr) {
        tcr.data.TradeReportID = tcr.data['571'];
        tcr.data.RefExecTradeReportID = tcr.data.ExecTradeReportID;
        tcr.data.RefCounterTradeReportID = tcr.data.CounterTradeReportID;
        tcr.data.ExecTradeReportID = 'L'+utils.randomString(null, 9);
        tcr.data.CounterTradeReportID = 'L'+utils.randomString(null, 9);
        tcr.data.TradeReportType = 6;
        tcr.data.ExecutionType = 'H';

        _ack_tcr(tcr, template.fix.pt_offbook_trade_capture_report_ack, 0, ['22','31','32','64','829','1041','1390']);
        _confirm_tcr(tcr, template.fix.pt_offbook_trade_capture_report_trade, 1, ['22']);
        tcr.status = "CLOSED";
    }
    // *********************************************

    // ************* Dual Party ********************
    // ---------------- New ---------------------
    var newDualPartyTCR = function(tcr) {
        if (parseInt(tcr.data["31"]) == 102) {
            var daydiff = moment().utc().isoWeekday() == 1 ? 3 : 1
            var origTradeTime =  moment().utc().subtract(daydiff, 'days').format("YYYYMMDD-HH:mm:ss");
            tcr.data["122"] = origTradeTime;
        }
        var rndId = utils.randomString(null, 9);
        var securityId = tcr.data['48'];
        var settlDate = moment().utc().format("YYYYMMDD");
        tcr.tradeId = "M"+rndId;
        tcr.tradeLinkId = "N"+rndId;
        tcr.data.TradeID = tcr.tradeId;
        tcr.data.TradeLinkID = tcr.tradeLinkId;
        if (tcr.data['64'] == undefined)
            tcr.data['64'] = settlDate;
        tcr.data['1390'] = 1;
        tcr.data.TradeReportStatus = 0;
        _ack_tcr(tcr, template.fix.pt_offbook_trade_capture_report_ack, 1, ['22']);

        tcr.data.ProductComplex = self.instruments.filter(function(o) { return o.exchangecode == securityId })[0].sourceexchange;
        tcr.data.ExecTradeReportID = 'L'+utils.randomString(null, 9);
        tcr.data.CounterTradeReportID = 'L'+utils.randomString(null, 9);
        tcr.data.ExecutionType = 'F';
        tcr.data.TradeReportType = 0;
        tcr.data.TradeReportTransType = 0;
        tcr.data.MatchType = 1;
        tcr.data.LastQty = tcr.data['32'];
        tcr.data.LastPx = tcr.data['31'];
        tcr.data.PriceType = 2;
        tcr.data.NotifyTradeReportType = 11;
        tcr.data.NotifyTradeReportTransType = 0;
        _notify_tcr(tcr, template.fix.pt_offbook_trade_capture_report_notify, ['22']);

        tcr.status = "NOTIFIED_CREATE";
    }

    var acceptDualPartyTCR = function(tcr) {
        tcr.data.TradeReportType = 0;
        tcr.data.ExecutionType = 'F';
        _ack_tcr(tcr, template.fix.pt_offbook_trade_capture_report_ack, 1, ['22']);
        _confirm_tcr(tcr, template.fix.pt_offbook_trade_capture_report_trade, 0, ['22']);
        tcr.status = "TRADED";
    }

    var declineDualPartyTCR = function(tcr) {
        if (tcr.status == "NOTIFIED_CANCEL") {
            _ack_tcr(tcr, template.fix.pt_offbook_trade_capture_report_ack, 1, ['22']);
            _notify_tcr(tcr, template.fix.pt_offbook_trade_capture_report_notify, ['22']);
        } else {
            tcr.data.NotifyTradeReportType = 3;
            tcr.data.NotifyTradeReportTransType = 1;

            _ack_tcr(tcr, template.fix.pt_offbook_trade_capture_report_ack, 1, ['22','32','31','64','829','1390']);
            _notify_tcr(tcr, template.fix.pt_offbook_trade_capture_report_notify, ['22','60','1390']);
        }
    }
    // ---------------------------------------------

    // -------------- Cancel ------------------------
    var cancelDualPartyTCR = function(tcr) {
        if (tcr.status == "ACK_WITHDRAW") {
            tcr.data.TradeReportStatus = 1;
            var msg_template = JSON.parse(JSON.stringify(template.fix.pt_offbook_trade_capture_report_ack));
            msg_template['751'] = '7050';
            msg_template['58'] = 'Cancellation process terminated';
            _ack_tcr(tcr, msg_template, 0, ['22']);
            tcr.status = "REJECTED";
        } else {
            _ack_tcr(tcr, template.fix.pt_offbook_trade_capture_report_ack, 0, ['22','32','31','64','829','1041','1390']);

            tcr.data.NotifyTradeReportType = 14;
            tcr.data.NotifyTradeReportTransType = 0;
            _notify_tcr(tcr, template.fix.pt_offbook_trade_capture_report_notify, ['22']);
            tcr.status = "NOTIFIED_CANCEL";
        }
    }

    var acceptCancelDualPartyTCR = function(tcr) {
        _ack_tcr(tcr, template.fix.pt_offbook_trade_capture_report_ack, 0, ['22','64','829']);
        tcr.data.ExecutionType = 'H';
        tcr.data.TradeReportType = 6;
        tcr.data.RefExecTradeReportID = tcr.data.ExecTradeReportID;
        tcr.data.RefCounterTradeReportID = tcr.data.CounterTradeReportID;
        tcr.data.ExecTradeReportID = 'L'+utils.randomString(null, 9);
        tcr.data.CounterTradeReportID = 'L'+utils.randomString(null, 9);

        _confirm_tcr(tcr, template.fix.pt_offbook_trade_capture_report_trade, 1, ['22']);
        tcr.status = "CLOSED";
    }

    var rejectCancelDualPartyTCR = function(tcr) {
        _ack_tcr(tcr, template.fix.pt_offbook_trade_capture_report_ack, 0, ['22','32','31','64','829','1041','1390']);

        tcr.data.NotifyTradeReportType = 3;
        tcr.data.NotifyTradeReportTransType = 1;
        _notify_tcr(tcr, template.fix.pt_offbook_trade_capture_report_notify, ['22']);
        tcr.status = "NOTIFIED_REJECT_CANCEL";
    }
    // ----------------------------------------------

    // ---------------- Reject ------------------
    var rejectTCR = function(tcr, reason, text) {
        tcr.data.TradeReportStatus = 1;
        var msg_template = JSON.parse(JSON.stringify(template.fix.pt_offbook_trade_capture_report_ack));
        msg_template['751'] = reason;
        msg_template['58'] = text;
        _ack_tcr(tcr, msg_template, 0, ['22','32','31','64','829','1041','1390']);
        tcr.status = "REJECTED";
    }
    //--------------------------------------------

    // ------------------ Withdraw ------------------
    var withdrawDualPartyTCR = function(tcr, cb) {
        if (tcr.status == "TRADED" || tcr.status == "DECLINED") {
            tcr.data.TradeReportStatus = 1;
            var msg_template = JSON.parse(JSON.stringify(template.fix.pt_offbook_trade_capture_report_ack));
            msg_template['751'] = '7060';
            msg_template['58'] = 'Request already accepted/declined';
            _ack_tcr(tcr, msg_template, 0, ['22','32','31','64','829','1041','1390']);
            tcr.status = "REJECTED";
        } else {
            tcr.data.NotifyTradeReportType = 11;
            tcr.data.NotifyTradeReportTransType = 1;

            _ack_tcr(tcr, template.fix.pt_offbook_trade_capture_report_ack, 0, ['22','32','31','64','829','1041','1390']);
            _notify_tcr(tcr, template.fix.pt_offbook_trade_capture_report_notify, ['22','1390']);
            tcr.status = "WITHDRAWED";
        }
    }

    var withdrawCancelDualPartyTCR = function(tcr, cb) {
        if (tcr.status == "NOTIFIED_REJECT_CANCEL") {
            tcr.data.TradeReportStatus = 1;
            var msg_template = template.fix.pt_offbook_trade_capture_report_ack;
            msg_template['751'] = '7004';
            msg_template['58'] = 'Unknown Trade ID';
            _ack_tcr(tcr, msg_template, 0, ['22','32','31','64','829','1041','1390']);
            tcr.status = "REJECTED";
        } else {
            tcr.data.NotifyTradeReportType = 3;
            tcr.data.NotifyTradeReportTransType = 1;

            _ack_tcr(tcr, template.fix.pt_offbook_trade_capture_report_ack, 0, ['22','32','31','64','829','1041','1390']);
            _notify_tcr(tcr, template.fix.pt_offbook_trade_capture_report_notify, ['22','1390']);
            tcr.status = "WITHDRAW_CANCELLED";
        }
    }
    // ----------------------------------------------
    // ************************************************************************
    var processOrderCreate = function(session, message) {
        var msg = message.message;
        var account = message.account;

        remove_unneccessary_tags(tcr_message);

        processOrder(session, account, msg);
    }

    var processMessage = function(msgtype, session, message) {
        switch(msgtype) {
            case "D": // Create Order
                processOrderCreate(session, message);
                break;
            case "G": // Amend Order
                processOrderAmend(session, message);
                break;
            case "F": // Cancel Order
                processOrderCancel(session, message);
                break;
            // case "AE": // PostTrade - Trade Capture Report
            //     processTradeCaptureReprort(session, message);
            //     break;
            // case "AF": // DropCopy - Order Mass Status Request
            //     processOrderMassStatusRequest(session, message);
            //     break;
            // case "AD": // PostTrade - Trade Capture Report Request
            //     processTradeCaptureReportRequest(session, message);
            //     break;
        }
    }

    var remove_unneccessary_tags = function(message) {
        var unneccessary_tags = [8, 9];

        unneccessary_tags.forEach(function(tag) {
            delete message[tag];
        });
    }



    // var processTradeCaptureReprort = function(session, message) {
    //     var tcr_message = message.message;
    //     var account = message.account;
    //     var tradeType = tcr_message['1123'];

    //     remove_unneccessary_tags(tcr_message);

    //     if (tradeType == undefined) { // Onbook Trade
    //         processOnBookTrade(session, account, tcr_message);
    //     } else {
    //         processOffBookTrade(session, account, tcr_message);
    //     }
    // }

    // var processOrderMassStatusRequest = function(session, message) {
    //     var msg = message.message;
    //     var broker = msg['453'][0]['448'];
    //     var massStatusReqID = msg['584'];
    //     var f_orders = self.orders.filter(function(o) { return o.status != 'CLOSED' && o.broker == broker });

    //     var parties = _build_onbook_parties(broker);
    //     var count = f_orders.length;
    //     var index = 1;
    //     f_orders.forEach(function(order) {
    //         var message_template = JSON.parse(JSON.stringify(template.fix.dc_execution_report));
    //         message_template['17'] = 0;
    //         message_template['150'] = 'I';
    //         message_template['584'] = massStatusReqID;
    //         if (index == count){
    //             message_template['912'] = 'Y';
    //         }
    //         message_template = _.extend({}, message_template, parties);
    //         _send_dropcopy_message(message_template, order);
    //         index = index + 1;
    //     })
    // }

    // var processTradeCaptureReportRequest = function(session, message) {
    //     var msg = message.message;
    //     var account = message.account;
    //     var tradeRequestID = msg['568'];
    //     var username = msg['49'];

    //     var unsentMsgs = self.ptQueue.filter(function(o) { return o.account == username && o.status == 1});
    //     var totNumTradeReports =  unsentMsgs.length;
    //     var index = 1;

    //     unsentMsgs.forEach(function(msg) {
    //         msg.status = 0;
    //         msg.message['568'] = tradeRequestID;
    //         if (index == totNumTradeReports){
    //             msg.message['912'] = 'Y';
    //         }
    //         index = index + 1;
    //     });

    //     var tcr = {
    //         account: account,
    //         data: {
    //             '568': tradeRequestID,
    //             '569': msg['569'],
    //             '748': totNumTradeReports
    //         }
    //     }

    //     _send_offbook_posttrade_message(template.pt.pt_offbook_trade_capture_report_request_ack, tcr, null, true);
    // }

    // ***********************************************************************
    self.process = function(msgtype, session, message) {
        // processMessage(msgtype, session, message);
        return;
    }

    self.clearIntervals = function(cb) {
        clearInterval(timer_gateway);
        cb();
    }
}
