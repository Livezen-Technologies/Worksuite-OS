/* Step 3 (design: Installer › Your account). No automatic sign-in: WorkSuite OS always asks for the password (SRS). */
import io.calamares.core 1.0
import io.calamares.ui 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

WsPage {
    id: page
    step: 3
    title: qsTr("Create your account")
    subtitle: qsTr("You'll use this to sign in and to approve system changes.")
    function onActivate() { config.setAutoLogin(false); arrive() }

    readonly property string initials: {
        var p = config.fullName.trim().split(/\s+/).filter(function (s) { return s.length })
        return p.length ? (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() : ""
    }
    readonly property int strength: {
        var s = pw.text, n = 0
        if (s.length >= 8) n++
        if (s.length >= 12) n++
        if (/[a-z]/.test(s) && /[A-Z]/.test(s)) n++
        if (/[0-9]/.test(s) && /[^A-Za-z0-9]/.test(s)) n++
        return s.length ? Math.max(1, n) : 0
    }
    readonly property bool matches: pw.text.length > 0 && pw.text === pw2.text

    RowLayout {
        anchors.left: parent.left; anchors.top: parent.top
        spacing: 48
        ColumnLayout {
            Layout.alignment: Qt.AlignTop
            spacing: 10
            Rectangle {
                width: 112; height: 112; radius: 56
                gradient: Gradient { orientation: Gradient.Horizontal; GradientStop { position: 0; color: "#1F6BFF" } GradientStop { position: 1; color: "#18D4F0" } }
                Text { anchors.centerIn: parent; text: page.initials; color: "#FFFFFF"; font.family: "IBM Plex Sans"; font.pixelSize: 40; font.weight: Font.DemiBold }
                Image { anchors.centerIn: parent; visible: page.initials === ""; source: "logo.svg"; sourceSize.width: 44; sourceSize.height: 44 }
            }
        }
        GridLayout {
            Layout.preferredWidth: 540
            columns: 2; rowSpacing: 16; columnSpacing: 16

            ColumnLayout {
                Layout.columnSpan: 2; Layout.fillWidth: true; spacing: 8
                WsLabel { text: qsTr("Your name") }
                WsField { Layout.fillWidth: true; text: config.fullName; placeholderText: qsTr("First and last name"); onTextChanged: config.setFullName(text) }
            }
            ColumnLayout {
                Layout.fillWidth: true; Layout.preferredWidth: 1; spacing: 8
                WsLabel { text: qsTr("Username") }
                WsField { Layout.fillWidth: true; mono: true; text: config.loginName; invalid: config.loginNameStatus !== ""; onTextChanged: config.setLoginName(text) }
            }
            ColumnLayout {
                Layout.fillWidth: true; Layout.preferredWidth: 1; spacing: 8
                WsLabel { text: qsTr("Computer name") }
                WsField { Layout.fillWidth: true; mono: true; text: config.hostname; invalid: config.hostnameStatus !== ""; onTextChanged: config.setHostName(text) }
            }
            ColumnLayout {
                Layout.fillWidth: true; Layout.preferredWidth: 1; spacing: 8
                WsLabel { text: qsTr("Password") }
                WsField { id: pw; Layout.fillWidth: true; echoMode: TextInput.Password; text: config.userPassword; onTextChanged: config.setUserPassword(text) }
            }
            ColumnLayout {
                Layout.fillWidth: true; Layout.preferredWidth: 1; spacing: 8
                WsLabel { text: qsTr("Confirm password") }
                WsField { id: pw2; Layout.fillWidth: true; echoMode: TextInput.Password; text: config.userPasswordSecondary; invalid: text.length > 0 && !page.matches; onTextChanged: config.setUserPasswordSecondary(text) }
            }
            RowLayout {
                Layout.columnSpan: 2; Layout.fillWidth: true; spacing: 12
                Row {
                    spacing: 4
                    Repeater {
                        model: 4
                        Rectangle {
                            width: 36; height: 4; radius: 2
                            color: index < page.strength ? (page.strength >= 3 ? "#5FD39A" : page.strength === 2 ? "#FFC85A" : "#FF9F5A") : "#1F7FB2FF"
                        }
                    }
                }
                Text {
                    Layout.fillWidth: true
                    readonly property string problem: config.loginNameStatus || config.hostnameStatus || (pw2.text.length && !page.matches ? qsTr("Passwords don't match") : "") || config.userPasswordMessage
                    text: problem !== "" ? problem
                        : pw.text.length ? [qsTr("Weak password"), qsTr("Weak password"), qsTr("Fair password"), qsTr("Strong password"), qsTr("Strong password")][page.strength] + qsTr(" · passwords match")
                        : qsTr("At least 8 characters")
                    color: problem !== "" ? "#FFB98A" : pw.text.length ? "#5FD39A" : "#8FA3C8"
                    font.family: "IBM Plex Sans"; font.pixelSize: 13; elide: Text.ElideRight
                }
            }
        }
    }
}
