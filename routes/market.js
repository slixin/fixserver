var express = require('express');
var router = express.Router();
var utils = require('./utils.js');
var moment = require('moment');
var MarketManager = require('./marketManager.js');
var csv = require('csvtojson');
var path = require('path');

router.post('/', function(req, res, next) {
    if (global.market == null) {
        res.status(400).send({ error: 'No market is running'});
    } else {
        res.send(global.market.config);
    }
});

router.post('/reset', function(req, res, next) {
    var gateway = req.body.gateway;
    var client = req.body.client;
    var data = JSON.parse(req.body.data);

    var gt = null;
    if (global.market == undefined) {
        res.status(400).send({ error: 'No market is running'});
    } else {
        var marketManager = global.market.instance;

        if (marketManager.gateways.length >= gateway) {
            gt = marketManager.gateways[gateway];
            if (gt.clients.has(client)) {
                gt.clients.get(client).session.modifyBehavior(data);
                res.send({});
            } else {
                res.status(400).send({ error: 'No client '+ client + ' on gateway: '+ gateway });
            }
        } else {
            res.status(400).send({ error: 'No gateway '+ gateway + ' is defined.' });
        }
    }
});

router.post('/start', function(req, res, next) {
    var market = req.body.market;

    if (market == null) {
        res.status(400).send({ error: 'Market is mandatory'});
    } else {
        var marketManager = new MarketManager(market);
        marketManager.start(function(err) {
            if (err) res.status(400).send( { error: err });
            else {
                market.isrunning = true;
                global.market = { config: market, instance: marketManager };
                res.send({});
            }
        });
    }
});

router.post('/stop', function(req, res, next) {
    if (global.market == undefined) {
        res.status(400).send({ error: 'No market is running'});
    } else {
        var marketManager = global.market.instance;
        marketManager.stop(function(err) {
            if (err) res.status(400).send( { error: err });
            else {
                global.market = null;
                res.send({ });
            }
        });
    }
});

router.post('/message/send', function(req, res, next) {
    if (global.market == undefined) {
        res.status(400).send({ error: 'No market is running'});
    } else {
        var marketManager = global.market.instance;
        var gateway = req.body.gateway;
        var message = req.body.message;
        var client = req.body.client;
        marketManager.send(gateway, client, message, function(outmsg) {
            res.send({ outmsg });
        });
    }
});


module.exports = router;
