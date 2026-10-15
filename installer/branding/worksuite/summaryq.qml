/* Step 5 (design: Installer › Review). The rows come from each step's summary; Install follows the typed disk
   confirmation (worksuiteconfirm@erase). */
import io.calamares.core 1.0
import io.calamares.ui 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

WsPage {
    step: 5
    title: qsTr("Ready to install")
    subtitle: qsTr("Check your choices. You can go back and change anything until you confirm the disk.")
    function onActivate() { arrive() }

    ColumnLayout {
        anchors.fill: parent
        spacing: 18
        WsCard {
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(rows.contentHeight + 2, parent.height - warn.height - 18)
            ListView {
                id: rows
                anchors.fill: parent; anchors.margins: 1
                clip: true
                model: config.summaryModel
                delegate: Item {
                    width: ListView.view.width
                    height: Math.max(52, msg.implicitHeight + 28)
                    Rectangle { visible: index > 0; width: parent.width; height: 1; color: "#1A7FB2FF" }
                    RowLayout {
                        anchors.fill: parent; anchors.leftMargin: 20; anchors.rightMargin: 20
                        spacing: 20
                        Text { Layout.preferredWidth: 150; Layout.alignment: Qt.AlignTop; Layout.topMargin: 16; text: model.title; color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 13; wrapMode: Text.WordWrap }
                        Text { id: msg; Layout.fillWidth: true; text: model.message; color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 14; wrapMode: Text.WordWrap; textFormat: Text.StyledText }
                    }
                }
            }
        }
        Rectangle {
            id: warn
            Layout.fillWidth: true
            implicitHeight: wcol.implicitHeight + 32
            radius: 12; color: "#1AFF9F5A"; border.width: 1; border.color: "#59FF9F5A"
            ColumnLayout {
                id: wcol; anchors.fill: parent; anchors.margins: 16; spacing: 4
                Text { text: qsTr("The selected disk will be erased"); color: "#FFB98A"; font.family: "IBM Plex Sans"; font.pixelSize: 14; font.weight: Font.DemiBold }
                Text { Layout.fillWidth: true; text: qsTr("Everything on it is deleted. Back up important files before continuing — you'll type the disk name to confirm."); color: "#C9D6EE"; font.family: "IBM Plex Sans"; font.pixelSize: 13; wrapMode: Text.WordWrap }
            }
        }
        Item { Layout.fillHeight: true }
    }
}
