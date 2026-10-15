/* Step 3 · Your account (design: Installer sub-steps › 3 · Name and password, 3 · Computer name): one Calamares page
   with two sub-steps. No automatic sign-in: WorkSuite OS always asks for the password (SRS WSOS-AUTH-002). */
import io.calamares.core 1.0
import io.calamares.ui 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

WsPage {
    id: page
    stepIndex: 3
    subCount: 2
    eyebrow: subStep === 0 ? qsTr("Step 3 · Name and password") : qsTr("Step 3 · Computer name")
    title: subStep === 0 ? qsTr("Who will use this computer?") : qsTr("Name this computer")
    subtitle: subStep === 0 ? "" : qsTr("Other devices on your network will see it by this name.")
    onActivated: config.setAutoLogin(false)

    readonly property string initials: {
        var p = config.fullName.trim().split(/\s+/).filter(function (s) { return s.length })
        return p.length ? (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() : ""
    }
    readonly property bool matches: pw.text.length > 0 && pw.text === pw2.text
    readonly property bool userOk: config.fullName.trim() !== "" && config.loginName !== "" && config.loginNameStatus === ""
        && matches && config.userPasswordValidity !== 2   // PasswordValidity::Invalid
    // The footer's Continue on the first sub-step needs the name and password done.
    subNextOk: userOk
    readonly property string firstName: config.loginName !== "" ? config.loginName : "user"

    // Sub-step 1: name and password.
    RowLayout {
        visible: page.subStep === 0
        anchors.left: parent.left; anchors.top: parent.top; anchors.right: parent.right
        spacing: 44
        ColumnLayout {
            Layout.alignment: Qt.AlignTop
            spacing: 10
            Rectangle {
                width: 112; height: 112; radius: 56
                gradient: Gradient { orientation: Gradient.Horizontal; GradientStop { position: 0; color: "#1F6BFF" } GradientStop { position: 1; color: "#18D4F0" } }
                Text { anchors.centerIn: parent; text: page.initials || "?"; color: "#FFFFFF"; font.family: "IBM Plex Sans"; font.pixelSize: 40; font.weight: Font.DemiBold }
            }
        }
        GridLayout {
            Layout.fillWidth: true; Layout.maximumWidth: 560
            columns: 2; rowSpacing: 18; columnSpacing: 16

            ColumnLayout {
                Layout.columnSpan: 2; Layout.fillWidth: true; spacing: 6
                WsLabel { text: qsTr("Your full name") }
                WsField { Layout.fillWidth: true; text: config.fullName; onTextChanged: config.setFullName(text) }
            }
            ColumnLayout {
                Layout.columnSpan: 2; Layout.fillWidth: true; spacing: 6
                WsLabel { text: qsTr("Username for signing in") }
                WsField { Layout.fillWidth: true; mono: true; text: config.loginName; invalid: config.loginNameStatus !== ""; onTextChanged: config.setLoginName(text) }
                Text {
                    text: config.loginNameStatus !== "" ? config.loginNameStatus : qsTr("Lowercase letters, numbers, - and _. Filled in from your name.")
                    color: config.loginNameStatus !== "" ? "#FF8A7A" : "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 12
                }
            }
            ColumnLayout {
                Layout.fillWidth: true; Layout.preferredWidth: 1; spacing: 6
                WsLabel { text: qsTr("Password") }
                WsField { id: pw; Layout.fillWidth: true; echoMode: TextInput.Password; text: config.userPassword; onTextChanged: config.setUserPassword(text) }
            }
            ColumnLayout {
                Layout.fillWidth: true; Layout.preferredWidth: 1; spacing: 6
                WsLabel { text: qsTr("Confirm password") }
                WsField { id: pw2; Layout.fillWidth: true; echoMode: TextInput.Password; text: config.userPasswordSecondary; invalid: text.length > 0 && !page.matches; onTextChanged: config.setUserPasswordSecondary(text) }
            }
            Text {
                Layout.columnSpan: 2; Layout.fillWidth: true
                readonly property string problem: pw.text.length === 0 ? "" : pw2.text.length && !page.matches ? qsTr("Passwords do not match") : config.userPasswordMessage
                text: problem !== "" ? problem : page.matches ? qsTr("Passwords match") : qsTr("At least 8 characters")
                color: problem !== "" ? "#FF8A7A" : page.matches ? "#5FD39A" : "#8FA3C8"
                font.family: "IBM Plex Sans"; font.pixelSize: 13; wrapMode: Text.WordWrap
            }
        }
    }

    // Sub-step 2: computer name.
    RowLayout {
        visible: page.subStep === 1
        anchors.left: parent.left; anchors.top: parent.top; anchors.right: parent.right
        spacing: 40
        Rectangle {
            Layout.preferredWidth: 300; Layout.preferredHeight: 200
            radius: 16; color: "#990E2048"; border.width: 1; border.color: "#247FB2FF"
            Column {
                anchors.centerIn: parent; spacing: 14
                Image { anchors.horizontalCenter: parent.horizontalCenter; source: "laptop.svg"; sourceSize.width: 96; sourceSize.height: 72 }
                Text { anchors.horizontalCenter: parent.horizontalCenter; text: config.hostname; color: "#FFFFFF"; font.family: "IBM Plex Mono"; font.pixelSize: 15 }
            }
        }
        ColumnLayout {
            Layout.fillWidth: true; Layout.maximumWidth: 460
            Layout.alignment: Qt.AlignVCenter
            spacing: 16
            ColumnLayout {
                spacing: 6
                WsLabel { text: qsTr("Computer name") }
                WsField { id: host; Layout.fillWidth: true; mono: true; text: config.hostname; invalid: config.hostnameStatus !== ""; onTextChanged: config.setHostName(text) }
                Text {
                    text: config.hostnameStatus !== "" ? config.hostnameStatus : qsTr("Lowercase letters, numbers and hyphens")
                    color: config.hostnameStatus !== "" ? "#FF8A7A" : "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 12
                }
            }
            ColumnLayout {
                spacing: 8
                Text { text: qsTr("Suggestions"); color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 13 }
                Flow {
                    Layout.fillWidth: true; spacing: 8
                    Repeater {
                        model: [page.firstName + "-laptop", page.firstName + "-worksuite", page.firstName + "-desktop"]
                        Rectangle {
                            width: chip.implicitWidth + 24; height: 34; radius: 17
                            color: chipMouse.containsMouse ? "#147FB2FF" : "transparent"; border.width: 1; border.color: "#407FB2FF"
                            Text { id: chip; anchors.centerIn: parent; text: modelData; color: "#E8EEFA"; font.family: "IBM Plex Mono"; font.pixelSize: 13 }
                            MouseArea { id: chipMouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: host.text = modelData }
                        }
                    }
                }
            }
        }
    }
}
