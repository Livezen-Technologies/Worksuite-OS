/* Step 1, Custom install (design: Installer › Language, keyboard column). Express passes over it. */
import io.calamares.core 1.0
import io.calamares.ui 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

WsPage {
    step: 1
    title: qsTr("Choose your keyboard")
    subtitle: qsTr("Pick a layout, then type in the box to check it.")
    skipInExpress: true
    function onActivate() { arrive() }

    RowLayout {
        anchors.fill: parent
        spacing: 32
        ColumnLayout {
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.preferredWidth: 1
            spacing: 10
            WsLabel { text: qsTr("Keyboard layout") }
            WsField { id: search; Layout.fillWidth: true; placeholderText: qsTr("Search layouts") }
            WsCard {
                Layout.fillWidth: true; Layout.fillHeight: true
                ListView {
                    anchors.fill: parent; anchors.margins: 6
                    clip: true; spacing: 2
                    model: config.keyboardLayoutsModel
                    Component.onCompleted: positionViewAtIndex(model.currentIndex, ListView.Center)
                    delegate: WsListRow {
                        readonly property bool match: search.text === "" || model.label.toLowerCase().indexOf(search.text.toLowerCase()) >= 0
                        width: ListView.view.width
                        visible: match; height: match ? 42 : 0
                        text: model.label
                        selected: index === config.keyboardLayoutsModel.currentIndex
                        onPicked: config.keyboardLayoutsModel.currentIndex = index
                    }
                }
            }
        }
        ColumnLayout {
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.preferredWidth: 1
            spacing: 10
            WsLabel { text: qsTr("Variant") }
            WsCard {
                Layout.fillWidth: true; Layout.fillHeight: true
                ListView {
                    anchors.fill: parent; anchors.margins: 6
                    clip: true; spacing: 2
                    model: config.keyboardVariantsModel
                    delegate: WsListRow {
                        width: ListView.view.width
                        text: model.label
                        selected: index === config.keyboardVariantsModel.currentIndex
                        onPicked: config.keyboardVariantsModel.currentIndex = index
                    }
                }
            }
            WsLabel { text: qsTr("Test your keyboard"); Layout.topMargin: 8 }
            WsField { Layout.fillWidth: true; placeholderText: qsTr("Type here to check the layout") }
        }
    }
}
