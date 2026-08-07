"""Restore ``MSS54_Disassembly_2025_09_16.gar`` into a usable Ghidra project.

Ghidra's own "Restore Project" lives in ``ArchivePlugin``/``RestoreTask``, which
are GUI-only and package-private, so they cannot be driven headlessly.  They do
not do anything exotic though - ``RestoreTask extends AbstractFileExtractorTask``
and simply unpacks the archive into the project directory.  This module gets to
the same place by creating an empty project through the public
``GhidraProject`` API and then unpacking the archive's ``idata``/``user``/
``versioned`` trees into its ``.rep`` folder.

The archive is treated as read-only input; everything is written to a scratch
directory so the committed ``.gar`` is never modified.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_GAR = REPO / "MSS54_Disassembly_2025_09_16.gar"

# Only these top-level trees belong to the project data store.
PROJECT_TREES = ("idata", "user", "versioned")


def unpack(gar: Path, rep_dir: Path) -> list[str]:
    """Extract the archive's project trees into ``rep_dir``.

    Entry names use Windows separators (``idata\\00\\00000005.prp``) because the
    archive was written on Windows, so they are normalised here.
    """
    written: list[str] = []
    with zipfile.ZipFile(gar) as zf:
        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            top = name.split("/", 1)[0]
            if top not in PROJECT_TREES:
                continue
            dest = rep_dir / name
            if name.endswith("/"):
                dest.mkdir(parents=True, exist_ok=True)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out)
            written.append(name)
    return written


def restore(gar: Path, workdir: Path, project_name: str) -> Path:
    """Create ``workdir/<project_name>.gpr`` populated from ``gar``."""
    import pyghidra  # noqa: PLC0415 - must come after pyghidra.start()

    from ghidra.base.project import GhidraProject  # type: ignore

    workdir.mkdir(parents=True, exist_ok=True)
    locator = workdir / f"{project_name}.gpr"
    rep_dir = workdir / f"{project_name}.rep"

    if locator.exists() or rep_dir.exists():
        shutil.rmtree(rep_dir, ignore_errors=True)
        locator.unlink(missing_ok=True)

    project = GhidraProject.createProject(str(workdir), project_name, False)
    try:
        pass
    finally:
        project.close()

    # Replace the freshly created (empty) data store with the archived one.
    for tree in PROJECT_TREES:
        shutil.rmtree(rep_dir / tree, ignore_errors=True)
    written = unpack(gar, rep_dir)
    print(f"restored {len(written)} entries into {rep_dir}")
    return locator


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gar", type=Path, default=DEFAULT_GAR)
    ap.add_argument("--workdir", type=Path, default=Path("/home/user/mss54-ghidra"))
    ap.add_argument("--name", default="MSS54_Disassembly")
    args = ap.parse_args(argv)

    import pyghidra

    pyghidra.start()

    locator = restore(args.gar, args.workdir, args.name)

    from ghidra.base.project import GhidraProject  # type: ignore

    project = GhidraProject.openProject(str(args.workdir), args.name, True)
    try:
        root = project.getProject().getProjectData().getRootFolder()
        files = list(root.getFiles())
        print(f"project {locator} contains {len(files)} file(s):")
        for df in files:
            print(f"  - {df.getName()}  [{df.getContentType()}]")
    finally:
        project.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
