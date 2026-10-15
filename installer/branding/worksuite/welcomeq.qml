/* Step 1 · Language (design: Installer sub-steps › 1 · Language): install mode, then the language. Express fills
   in the keyboard and the time zone with defaults; Custom shows those pages. */
import io.calamares.core 1.0
import io.calamares.ui 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

WsPage {
    id: page
    eyebrow: qsTr("Step 1 · Language")
    title: qsTr("Choose your language")
    subtitle: qsTr("Used for the installer and your new system.")
    property bool expressChosen: page.state.get("express", true)
    onExpressChosenChanged: page.state.set("express", expressChosen)
    function onActivate() { page.state.set("express", expressChosen); arrive() }
    function onLeave() { leave() }

    ColumnLayout {
        anchors.fill: parent
        spacing: 18

        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            WsChoice {
                Layout.fillWidth: true; Layout.fillHeight: true; Layout.preferredWidth: 1
                title: qsTr("Express install")
                text: qsTr("Sensible defaults: US keyboard and Asia/Colombo time. You can change both later in Settings.")
                selected: page.expressChosen
                onPicked: page.expressChosen = true
            }
            WsChoice {
                Layout.fillWidth: true; Layout.fillHeight: true; Layout.preferredWidth: 1
                title: qsTr("Custom install")
                text: qsTr("Choose keyboard, time zone and every other setting yourself.")
                selected: !page.expressChosen
                onPicked: page.expressChosen = false
            }
        }

        WsField { id: search; Layout.fillWidth: true; placeholderText: qsTr("Search languages") }

        GridView {
            id: grid
            Layout.fillWidth: true; Layout.fillHeight: true
            clip: true
            cellWidth: width / 3; cellHeight: 52
            model: config.languagesModel
            Component.onCompleted: positionViewAtIndex(config.localeIndex, GridView.Center)
            delegate: Item {
                readonly property bool match: search.text === "" || (model.label + " " + model.englishLabel).toLowerCase().indexOf(search.text.toLowerCase()) >= 0
                readonly property bool selected: index === config.localeIndex
                width: match ? grid.cellWidth : 0; height: match ? grid.cellHeight : 0
                visible: match
                Rectangle {
                    anchors.fill: parent; anchors.rightMargin: 8; anchors.bottomMargin: 8
                    radius: 10
                    color: selected ? "#1F6BFF" : mouse.containsMouse ? "#B30E2048" : "#990E2048"
                    border.width: 1; border.color: selected ? "#1F6BFF" : "#247FB2FF"
                    RowLayout {
                        anchors.fill: parent; anchors.leftMargin: 14; anchors.rightMargin: 14
                        Text { Layout.fillWidth: true; text: model.label; color: "#FFFFFF"; font.family: "IBM Plex Sans"; font.pixelSize: 14; elide: Text.ElideRight }
                        Text { text: model.englishLabel !== model.label ? model.englishLabel : ""; color: "#FFFFFF"; opacity: 0.75; font.family: "IBM Plex Sans"; font.pixelSize: 13; elide: Text.ElideRight; Layout.maximumWidth: 110 }
                    }
                    MouseArea { id: mouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: config.localeIndex = index }
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            visible: !config.requirementsModel.satisfiedRequirements
            implicitHeight: warn.implicitHeight + 28
            radius: 12; color: "#14FF9F5A"; border.width: 1; border.color: "#4DFF9F5A"
            Text {
                id: warn
                anchors.fill: parent; anchors.margins: 14
                text: config.warningMessage
                color: "#FFB98A"; font.family: "IBM Plex Sans"; font.pixelSize: 13; wrapMode: Text.WordWrap; textFormat: Text.StyledText
            }
        }
    }
}
