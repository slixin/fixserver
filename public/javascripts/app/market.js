app.controller('ctrlMarket', ['$scope','$routeParams', '$http', 'moment','Notification', 'fileReader', 'FileSaver', 'Blob', '$uibModal',
    function($scope, $routeParams, $http, moment, Notification, fileReader, FileSaver, Blob, $uibModal) {
    $scope.market = null;

    var showForm = function (settings, callback) {
        var modalInstance = $uibModal.open({
            animation: true,
            templateUrl: 'views/modal-settings.html',
            controller: 'SettingsModalCtrl',
            size: 'lg',
            scope: $scope,
            resolve: {
                settingsForm: function () {
                    return $scope.settingsForm;
                },
                settings: function() {
                    if (settings != undefined)
                        return settings;
                    else
                        return {};
                }
            }
        });

        modalInstance.result.then(function (result) {
            callback(result);
        }, null);
    };

    $scope.new_market = {
        isrunning: false,
        createdtime : null,
        type: "COMMON",
        name: "Untitled FIX Market",
        description: null,
        parites: null,
        gateways : [
            {
                fixversion: 'FIX.4.4',
                spec: 'fix.4.4',
                port: 8808,
                options: null,
                accounts: JSON.stringify([
                    {
                        senderID: "SENDER",
                        targetID: "TARGER",
                        password: "123456",
                        brokerid: "B1"
                    }
                ])
            }
        ]
    }

    var isJSON = function(str) {
        try {
            JSON.parse(str);
        } catch (e) {
            return false;
        }
        return true;
    }

    var getMarket = function(){
        $http.post('/market/', {
        }).then(function(resp) {
            if (resp.data) {
                $scope.market = resp.data;
            }
        }, function(err) {
            Notification({message: 'Error:'+ err.data.error, delay: 2000});
        });
    }

    var saveMarket = function() {
        var data = new Blob([JSON.stringify($scope.market)], { type: 'application/json;charset=utf-8' });
        FileSaver.saveAs(data, "mysetting.json");
    }

    getMarket();

    $scope.getFile = function () {
        fileReader.readAsDataUrl($scope.file, $scope)
                  .then(function(result) {
                        if (isJSON(result))
                        {
                            $scope.market = JSON.parse(result);
                        } else {
                            Notification({message: 'Market setting file is invalid JSON', delay: 2000});
                        }
                  });
    };

    $scope.newMarket = function(type) {
        var newmarket = angular.copy($scope.new_market);
        showForm(newmarket, function(result){
            if (result != undefined)
            {
                $scope.market = result;
                saveMarket();
            }
        });
    }

    $scope.editMarket = function(market) {
        showForm(market, function(result){
            if (result != undefined)
            {
                $scope.market = result;
                saveMarket();
            }
        });
    }

    $scope.startMarket = function(market) {
        $http.post('/market/start', {
            "market": market
        }).then(function(resp) {
            if (resp.data) {
                $scope.market.isrunning = true;
            }
        }, function(err) {
            Notification({message: 'Error:'+ err.data.error, delay: 2000});
        });
    }

    $scope.stopMarket = function(market) {
        $http.post('/market/stop', {
        }).then(function(resp) {
            if (resp.data) {
                $scope.market.isrunning = false;
            }
        }, function(err) {
            Notification({message: 'Error:'+ err.data.error, delay: 2000});
        });
    }
}]);




