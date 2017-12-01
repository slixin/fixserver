app.controller('SettingsModalCtrl', function ModalInstanceCtrl ($scope, $uibModalInstance, settingsForm, settings) {
    $scope.form = {}
    $scope.settings = settings;

    $scope.markettypes = [
        {value: 1, text: 'COMMON'}
    ];

    $scope.submitForm = function (settings) {
        if ($scope.form.settingsForm.$valid) {
            var newSettings = {
                name: settings.name,
                createdtime: moment(),
                description: settings.description,
                type:settings.type,
                parties:settings.parties,
                gateways:settings.gateways,
            }
            $uibModalInstance.close(newSettings);
        }
    };

    $scope.cancel = function () {
        $uibModalInstance.dismiss(null);
    };

    var newguid = function() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0,
                v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
});
