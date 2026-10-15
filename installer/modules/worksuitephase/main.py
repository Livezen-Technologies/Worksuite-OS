# WorkSuite OS installer job: records the install stage in global storage ("worksuitePhase") so the slideshow
# (branding/worksuite/show.qml) can show Copy files, then Configure system with each task ticked off as it ends.
# Calamares does not pass job progress to the slideshow; these markers are its only real source.
import libcalamares

GS_KEY = "worksuitePhase"
PHASES = ("copy", "locale", "unlock", "account", "components", "boot", "cleanup")


def pretty_name():
    return "Preparing the next step"


def run():
    phase = (libcalamares.job.configuration or {}).get("phase")
    if phase not in PHASES:
        return ("Bad configuration", "worksuitephase: unknown phase {!r}".format(phase))
    libcalamares.globalstorage.insert(GS_KEY, phase)
    return None
