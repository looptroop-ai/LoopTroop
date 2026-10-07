"""Extract GitHub's raw artifact downloads while keeping their directory layout."""
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import shutil
import stat
import zipfile

raw = Path(os.environ['ARTIFACT_RAW']).resolve()
merge = os.environ['ARTIFACT_MERGE'] == 'true'

try:
    configured = Path(os.environ['ARTIFACT_DESTINATION'] or os.environ['GITHUB_WORKSPACE']).expanduser().absolute()
    destination = configured.resolve()
    roots = [(Path(os.environ[key]).absolute(), Path(os.environ[key]).resolve())
             for key in ('GITHUB_WORKSPACE', 'RUNNER_TEMP') if os.environ.get(key)]
    if not any(configured.is_relative_to(base) and destination.is_relative_to(resolved)
               and destination == Path(os.path.abspath(resolved / configured.relative_to(base)))
               for root, resolved in roots for base in (root, resolved)):
        raise ValueError(f'Artifact destination escapes workspace or runner temporary directory, or follows an untrusted symlink: {configured}')
    destination.mkdir(parents=True, exist_ok=True)
    for archive in sorted(raw.rglob('*')):
        if not archive.is_file():
            continue
        target = (destination if merge else destination / archive.parent.relative_to(raw)).resolve()
        if not target.is_relative_to(destination):
            raise ValueError(f'Artifact directory escapes destination: {archive.parent.name}')
        with zipfile.ZipFile(archive) as source:
            for entry in source.infolist():
                name = PurePosixPath(entry.filename.replace('\\', '/'))
                if name.is_absolute() or '..' in name.parts or PureWindowsPath(entry.filename).drive or stat.S_ISLNK(entry.external_attr >> 16):
                    raise ValueError(f'Unsafe artifact path: {entry.filename}')
                output = (target / name).resolve()
                if not output.is_relative_to(target):
                    raise ValueError(f'Artifact path escapes destination: {entry.filename}')
                if entry.is_dir():
                    output.mkdir(parents=True, exist_ok=True)
                else:
                    output.parent.mkdir(parents=True, exist_ok=True)
                    with source.open(entry) as contents, output.open('wb') as result:
                        shutil.copyfileobj(contents, result)
finally:
    shutil.rmtree(raw)
