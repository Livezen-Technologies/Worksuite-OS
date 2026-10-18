/* The installer's loading screen, continued inside Calamares.

   On the live ISO the installer starts behind the veil (worksuite_greeter/veil.py --installer): the boot splash's
   column, animated, under "Starting the installer…". The veil passes its animation clock and texts to Calamares
   (WORKSUITE_INTRO_T0, _TITLE, _VERSION, WORKSUITE_REDUCED_MOTION). When Calamares' main window shows, a curtain over
   it draws the same frame at the same moment of the same animation, so the switch from the veil's window to Calamares'
   is invisible; after a short hold it cross-fades into the first page (Language) while the mark glides into the
   sidebar's logo. Reduced motion: a still frame and a plain fade. Without WORKSUITE_INTRO_T0 (Calamares started some
   other way) nothing changes. */
#ifndef WORKSUITE_WSINTRO_H
#define WORKSUITE_WSINTRO_H

#include <QString>

class QWidget;

namespace WsIntro
{
struct Options
{
    bool enabled = false;
    qint64 t0Us = 0;   ///< the veil's animation start, CLOCK_MONOTONIC in µs (GLib's monotonic time)
    QString title;
    QString version;
    bool reducedMotion = false;
};

/// The veil's hand-over, from the environment.
Options fromEnvironment();
/// Watches for Calamares' main window (#mainApp) and covers it when it first shows; once per process.
void install();
/// Covers @p window with the loading frame and fades into it; the curtain deletes itself when done.
QWidget* cover( QWidget* window, const Options& o );
}  // namespace WsIntro

#endif
