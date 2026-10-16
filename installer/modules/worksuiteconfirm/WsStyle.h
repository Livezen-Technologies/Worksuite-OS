/* Runtime restyling of stock Calamares widgets toward the WorkSuite installer design (WorksuiteConfirmViewStep's
   application event filter calls these):
   - the partition module's ChoicePage (Qt Widgets, no QML in Calamares 3.3) as the design's "2 · Disk" and
     "2 · Encryption" sub-steps, keeping the stock widgets that carry the partitioning behaviour;
   - message boxes and the error dialog as the design's dialog kit (badge, title, body, button band). */
#ifndef WORKSUITE_WSSTYLE_H
#define WORKSUITE_WSSTYLE_H

#include <QString>

class QWidget;

namespace WsStyle
{
/// Builds the design's Disk / Encryption page over a ChoicePage (once; later calls do nothing).
void styleChoicePage( QWidget* choicePage );
/// Before a dialog's window exists: frameless and translucent, so the card can be rounded with a shadow.
void prepareDialog( QWidget* dialog );
/// When a QMessageBox or Calamares::ErrorDialog shows: rebuilds it as the design's dialog card.
void styleDialog( QWidget* dialog );
/// When a styled dialog hides: removes the dimmed backdrop over the main window.
void dialogHidden( QWidget* dialog );

/// Passphrase strength as the design scores it: 0 (empty) to 4 (Strong).
int passphraseScore( const QString& passphrase );
/// "512 MiB", "39.50 GiB".
QString sizeText( qint64 bytes );
}  // namespace WsStyle

#endif
