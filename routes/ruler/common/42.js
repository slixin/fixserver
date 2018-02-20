var request = require('request');
var utils = require('../../utils.js');
var async = require('async');
var dict = require('dict');
var _ = require('underscore');
var template = require('./42.json');
var moment = require('moment-timezone');

module.exports = CommonRuler;

function CommonRuler(market, log) {
    var self = this;

    self.market = market;
    self.log = log;

    self.gateways = [];
    self.orders = [];
    self.tcrs = [];

    self.msgQueue = [];

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
                if(!ignore) {
                    obj.data[key] = message[key];
                }
            }
        }
    }

    var _send_message = function(message_template, order) {
        var session = order.session;
        var account = order.account;
        var order_data = JSON.parse(JSON.stringify(order.data));
        var message = JSON.parse(JSON.stringify(message_template));

        self.msgQueue.push({
            session: session,
            account: account,
            data: order_data,
            message: message,
            status: 0
        });
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
        var messages = self.msgQueue.filter(function(o) { return o.status == 0 });
        if (messages.length > 0) {
            var message = messages[0];
            var client = self.gateways[0].clients.get(message.account);
            if (client == undefined) {
                message.status = 1; // Not be sent
            } else {
                var socket = client.socket;
                if (socket == undefined){
                    message.status = 1; // Not be sent
                } else {
                    message.status = 2; // Sent
                    send(message, function(msg) {});
                }
            }
        }
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
    // **********************************************

    // ********************** TCR ***************************
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
        var account = message.account;
        var status = "CREATE";

        var order = {
            session: session,
            account: account,
            status: status,
            data: {},
            trades: [],
            children: []
        };

        _updateData(order, message.message);
        order.data.CompID = account;
        order.data.ExecutionID = "E"+utils.randomString(null, 11);
        order.data.OrderID = "O"+utils.randomString(null, 11);
        order.data.TransactTime = (((new Date).getTime()) / 1000).toFixed(3).toString();
        order.data.CumQuantity = 0;
        order.data.LeavesQuantity = order.data["38"];
        order.data.DisplayQuantity = order.data["38"];
        order.data.OrderStatus = "0";
        order.data.ExecutionType = "0";
        order.data.ExecTransType = 0;
        order.data.Symbol = order.data["55"];
        order.data.Side = order.data["54"];
        order.data.ClientOrderID = order.data["11"];

        self.orders.push(order);

        _send_message(template.fix.execution_report, order);
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
        processMessage(msgtype, session, message);
        return;
    }

    self.clearIntervals = function(cb) {
        clearInterval(timer_gateway);
        cb();
    }
}
