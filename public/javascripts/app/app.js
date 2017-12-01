var app = angular.module('app',['ngRoute', 'ui.bootstrap', 'angularMoment','ui-notification', 'xeditable', 'ngFileSaver']);

app.config(['$routeProvider', function($routeProvider) {
    $routeProvider
        .when('/market', {
            templateUrl: '/views/market.html',
            controller: 'ctrlMarket'
        })
        .otherwise({
            templateUrl: '/views/main.html',
            controller: 'ctrlMain'
        });
}]);

app.run(function(editableOptions) {
  editableOptions.theme = 'bs3'; // bootstrap3 theme. Can be also 'bs2', 'default'
});


app.directive("ngFileSelect",function(){
  return {
    link: function($scope,el){
      el.bind("change", function(e){
        $scope.file = (e.srcElement || e.target).files[0];
        $scope.getFile();
      })
    }
  }
})

var fileReader = function ($q, $log) {
    var onLoad = function(reader, deferred, scope) {
        return function () {
            scope.$apply(function () {
                deferred.resolve(reader.result);
            });
        };
    };

    var onError = function (reader, deferred, scope) {
        return function () {
            scope.$apply(function () {
                deferred.reject(reader.result);
            });
        };
    };

    var onProgress = function(reader, scope) {
        return function (event) {
            scope.$broadcast("fileProgress",
                {
                    total: event.total,
                    loaded: event.loaded
                });
        };
    };

    var getReader = function(deferred, scope) {
        var reader = new FileReader();
        reader.onload = onLoad(reader, deferred, scope);
        reader.onerror = onError(reader, deferred, scope);
        reader.onprogress = onProgress(reader, scope);
        return reader;
    };

    var readAsDataURL = function (file, scope) {
        var deferred = $q.defer();

        var reader = getReader(deferred, scope);
        reader.readAsText(file);

        return deferred.promise;
    };

    return {
        readAsDataUrl: readAsDataURL
    };
};

app.factory("fileReader", ["$q", "$log", fileReader]);

app.config(function(NotificationProvider) {
    NotificationProvider.setOptions({
        delay: 4000,
        startTop: 0,
        verticalSpacing: 20,
        horizontalSpacing: 20,
        replaceMessage: true,
        positionX: 'center',
        positionY: 'top'
    });
});

