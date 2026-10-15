/* Step 1 (design: Installer › Language): language, and how to install. Express fills in the keyboard (from the
   language) and the time zone, and asks only for the disk and the account. */
import io.calamares.core 1.0
import io.calamares.ui 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

WsPage {
    id: page
    step: 1
    title: qsTr("Welcome to WorkSuite OS")
    subtitle: qsTr("Choose your language and how you'd like to install.")
    property bool expressChosen: true
    function onActivate() {
        Global.insert("worksuiteExpress", expressChosen)
        arrive()
    }
    function onLeave() { Global.insert("worksuiteExpress", expressChosen) }

    RowLayout {
        anchors.fill: parent
        spacing: 32

        ColumnLayout {
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.preferredWidth: 1
            spacing: 10
            WsLabel { text: qsTr("Language") }
            WsField { id: search; Layout.fillWidth: true; placeholderText: qsTr("Search languages") }
            WsCard {
                Layout.fillWidth: true; Layout.fillHeight: true
                ListView {
                    id: langs
                    anchors.fill: parent; anchors.margins: 6
                    clip: true; spacing: 2
                    model: config.languagesModel
                    currentIndex: config.localeIndex
                    Component.onCompleted: positionViewAtIndex(config.localeIndex, ListView.Center)
                    delegate: WsListRow {
                        readonly property bool match: search.text === "" || (model.label + " " + model.englishLabel).toLowerCase().indexOf(search.text.toLowerCase()) >= 0
                        width: ListView.view.width
                        visible: match; height: match ? 42 : 0
                        text: model.label
                        detail: model.englishLabel !== model.label ? model.englishLabel : ""
                        selected: index === config.localeIndex
                        onPicked: config.localeIndex = index
                    }
                }
            }
        }

        ColumnLayout {
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.preferredWidth: 1
            spacing: 12
            WsLabel { text: qsTr("Installation") }
            WsChoice {
                Layout.fillWidth: true
                title: qsTr("Express install"); badge: qsTr("RECOMMENDED")
                text: qsTr("Erases the disk you pick and encrypts it. Keyboard and time zone follow your language — you only create your account.")
                selected: page.expressChosen
                onPicked: { page.expressChosen = true; Global.insert("worksuiteExpress", true) }
            }
            WsChoice {
                Layout.fillWidth: true
                title: qsTr("Custom install")
                text: qsTr("Choose the keyboard layout and time zone yourself, step by step.")
                selected: !page.expressChosen
                onPicked: { page.expressChosen = false; Global.insert("worksuiteExpress", false) }
            }
            Item { Layout.fillHeight: true }
            Rectangle {
                Layout.fillWidth: true
                visible: !config.requirementsModel.satisfiedRequirements
                implicitHeight: warn.implicitHeight + 32
                radius: 12; color: "#1AFF9F5A"; border.width: 1; border.color: "#59FF9F5A"
                Text {
                    id: warn
                    anchors.fill: parent; anchors.margins: 16
                    text: config.warningMessage
                    color: "#FFB98A"; font.family: "IBM Plex Sans"; font.pixelSize: 13; wrapMode: Text.WordWrap; textFormat: Text.StyledText
                }
            }
        }
    }
}
