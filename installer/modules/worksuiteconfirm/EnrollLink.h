/* Enrollment from the installer (WSOS-INS-006): what the "Enroll this device" page accepts.
 *   - the admin console's enrollment link, https://<server>/enroll#token=<token> (pasted, or read from its QR code);
 *   - or a server address and an enrollment code typed separately.
 * The token is never logged; it is written only to a 0600 root file (pendingPath()) that the worksuiteenroll job
 * moves into the installed system, where the device agent enrolls on first boot. QtCore only, so it is unit-tested
 * without a display. */
#pragma once

#include <QByteArray>
#include <QString>

namespace WsEnroll
{
struct Target
{
    QString server;  ///< https://host[:port]/[path/] with a trailing slash
    QString token;
};

/// Server address as typed ("work.example.com", "https://work.example.com/x") → https URL with a trailing slash;
/// empty when it is not a plain https host (no credentials, query or fragment; http refused).
QString normalizeServer( const QString& typed );
/// Enrollment code shape: 8–512 of A–Z a–z 0–9 _ - . ~
bool validToken( const QString& token );
/// The console's link (also accepts a "token=" query for older links); false when it is not one.
bool parseLink( const QString& link, Target& out );
/// From the page's fields: a pasted link in either field wins; otherwise server + code. False when incomplete/invalid.
bool fromFields( const QString& server, const QString& code, Target& out );
/// {"server": …, "enrollment_token": …} for the device agent.
QByteArray toJson( const Target& t );
/// Written by the installer page (root, 0600), consumed by the worksuiteenroll job.
QString pendingPath();
/// Writes toJson(t) to path with mode 0600 (created that way, never wider); true on success.
bool writePending( const QString& path, const Target& t );
}  // namespace WsEnroll
