#!/usr/bin/env python3
import builtins
import importlib
import io
import os
import socket
import sys
import types
from pathlib import Path


_REAL_OPEN = builtins.open
_REAL_IO_OPEN = io.open
_REAL_SOCKET = socket.socket
_GUARD_FILE = Path(__file__).resolve()
RUNTIME_ROOT = _GUARD_FILE.parents[1]
_SANDBOX_DEBUG = os.environ.get('MATH_MODEL_SANDBOX_DEBUG') == '1'


def _resolve_path(value):
    if isinstance(value, bytes):
        value = os.fsdecode(value)
    if isinstance(value, int):
        return value
    if value is None:
        raise PermissionError('path is required')
    candidate = Path(os.fspath(value))
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    return candidate.resolve(strict=False)


PROJECT_ROOT = _resolve_path(os.environ.get('PROJECT_ROOT') or '.')


def _configured_workspace_path(variable, fallback):
    raw = os.environ.get(variable)
    candidate = _resolve_path(raw) if raw else fallback
    if candidate != PROJECT_ROOT and PROJECT_ROOT not in candidate.parents:
        raise PermissionError(f'{variable} outside workspace')
    return candidate


STAGE_ROOT = _configured_workspace_path('WORKSPACE_STAGE_ROOT', PROJECT_ROOT)
WORKSPACE_CWD = _configured_workspace_path('WORKSPACE_CWD', PROJECT_ROOT)
if not WORKSPACE_CWD.is_dir():
    raise PermissionError('workspace execution directory is unavailable')


def _under(path, roots):
    return any(path == root or root in path.parents for root in roots)


def _trusted_library_roots():
    roots = []
    for raw in (sys.prefix, sys.base_prefix, sys.exec_prefix, sys.executable and Path(sys.executable).parent):
        if not raw:
            continue
        try:
            candidate = _resolve_path(raw)
        except (OSError, TypeError, ValueError):
            continue
        if candidate not in roots:
            roots.append(candidate)
    return roots


def _trusted_font_roots():
    candidates = []
    windows_root = os.environ.get('WINDIR') or os.environ.get('SYSTEMROOT')
    if windows_root:
        candidates.append(Path(windows_root) / 'Fonts')
    for variable in ('LOCALAPPDATA', 'APPDATA'):
        if os.environ.get(variable):
            candidates.append(Path(os.environ[variable]) / 'Microsoft' / 'Windows' / 'Fonts')
    roots = []
    for raw in candidates:
        try:
            candidate = _resolve_path(raw)
        except (OSError, TypeError, ValueError):
            continue
        if candidate not in roots:
            roots.append(candidate)
    return roots


LIBRARY_ROOTS = _trusted_library_roots()
FONT_ROOTS = _trusted_font_roots()
READ_ROOTS = tuple(dict.fromkeys((PROJECT_ROOT, RUNTIME_ROOT, *LIBRARY_ROOTS, *FONT_ROOTS)))
SAFE_SYSTEM_ENV = {
    key: value for key in ('WINDIR', 'SYSTEMROOT')
    if (value := os.environ.get(key))
}


def _path_from_fd(value):
    if not isinstance(value, int):
        return None
    if value in (0, 1, 2):
        return value
    raise PermissionError('file descriptor access is not allowed by the sandbox')


def _check_read(value):
    path = _path_from_fd(value)
    if path is not None:
        return path
    candidate = _resolve_path(value)
    if not _under(candidate, READ_ROOTS):
        raise PermissionError(f'cannot read outside approved roots: {value}')
    return candidate


def _check_write(value):
    path = _path_from_fd(value)
    if path is not None:
        raise PermissionError('file descriptor writes are not allowed by the sandbox')
    candidate = _resolve_path(value)
    if not _under(candidate, (STAGE_ROOT,)):
        raise PermissionError(f'cannot write outside stage root: {value}')
    return candidate


def _check_link_target(source, destination):
    destination_path = _check_write(destination)
    source_path = _resolve_path(source)
    if not os.path.isabs(os.fspath(source)):
        source_path = (destination_path.parent / os.fspath(source)).resolve(strict=False)
    _check_read(source_path)
    return destination_path


def _is_write_mode(mode, flags=None):
    if isinstance(mode, str) and any(marker in mode for marker in ('w', 'a', 'x', '+')):
        return True
    if isinstance(flags, int):
        return bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
    return False


def _network_error():
    raise PermissionError('模型求解阶段禁止网络访问。如需联网数据源，请在设置中显式授权。')


def _non_default_dir_fd(value):
    return value not in (None, -1)


_ALLOW_NETWORK = os.environ.get('ALLOW_NETWORK') == '1'
_BLOCKED_IMPORTS = {
    'multiprocessing',
}


def _blocked_import(name):
    top = str(name or '').split('.', 1)[0].lower()
    return top in {item.split('.', 1)[0] for item in _BLOCKED_IMPORTS}


def _audit(event, args):
    if event == 'import' and args and _blocked_import(args[0]):
        raise ImportError(f'import blocked by sandbox: {args[0]}')
    if event.startswith('subprocess.') or event.startswith('os.exec') or event in {
        'os.system', 'os.popen', 'os.spawn', 'os.posix_spawn', 'os.posix_spawnp',
        'os.startfile', 'multiprocessing.Process',
    }:
        raise PermissionError('child-process creation is disabled in the sandbox')
    if event.startswith('socket.') and not _ALLOW_NETWORK:
        _network_error()
    if event == 'open':
        path = args[0] if args else None
        mode = args[1] if len(args) > 1 else None
        flags = args[2] if len(args) > 2 else None
        if _is_write_mode(mode, flags):
            _check_write(path)
        else:
            _check_read(path)
        return
    if event in {'os.listdir', 'os.scandir', 'os.walk', 'os.fwalk', 'os.stat', 'os.lstat', 'os.access', 'os.readlink'}:
        if args:
            _check_read(args[0])
        return
    if event in {'os.remove', 'os.unlink', 'os.rmdir', 'os.mkdir', 'os.makedirs', 'os.chmod', 'os.chown', 'os.truncate', 'os.utime'}:
        if args:
            _check_write(args[0])
        dir_fd_index = {
            'os.remove': 1, 'os.unlink': 1, 'os.rmdir': 1,
            'os.mkdir': 2, 'os.makedirs': 2, 'os.chmod': 2,
            'os.chown': 3, 'os.utime': 3,
        }.get(event)
        if dir_fd_index is not None and len(args) > dir_fd_index and _non_default_dir_fd(args[dir_fd_index]):
            raise PermissionError('directory file descriptors are not allowed by the sandbox')
        return
    if event in {'os.rename', 'os.replace'}:
        if len(args) >= 2:
            _check_write(args[0])
            _check_write(args[1])
        if len(args) > 3 and (_non_default_dir_fd(args[2]) or _non_default_dir_fd(args[3])):
            raise PermissionError('directory file descriptors are not allowed by the sandbox')
        return
    if event == 'os.symlink':
        if len(args) >= 2:
            _check_link_target(args[0], args[1])
        if len(args) > 2 and _non_default_dir_fd(args[2]):
            raise PermissionError('directory file descriptors are not allowed by the sandbox')
        return
    if event == 'os.link':
        if len(args) >= 2:
            _check_write(args[0])
            _check_write(args[1])
        if len(args) > 3 and (_non_default_dir_fd(args[2]) or _non_default_dir_fd(args[3])):
            raise PermissionError('directory file descriptors are not allowed by the sandbox')
        return
    if event in {'os.chdir', 'os.fchdir'}:
        if event == 'os.fchdir' or not args:
            raise PermissionError('changing directory by descriptor is not allowed by the sandbox')
        _check_read(args[0])
        return
    if event in {'os.putenv', 'os.unsetenv'}:
        return


sys.addaudithook(_audit)


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level == 0 and _blocked_import(name):
        raise ImportError(f'import blocked by sandbox: {name}')
    module = _REAL_IMPORT(name, globals, locals, fromlist, level)
    if level == 0:
        _guard_imported_module(str(name).split('.', 1)[0], sys.modules.get(str(name).split('.', 1)[0]))
    return module


def _guarded_import_module(name, package=None):
    if _blocked_import(name):
        raise ImportError(f'import blocked by sandbox: {name}')
    module = _REAL_IMPORT_MODULE(name, package)
    _guard_imported_module(str(name).split('.', 1)[0], module)
    return module


def _guarded_open(file, *args, **kwargs):
    mode = args[0] if args else kwargs.get('mode', 'r')
    path = _check_write(file) if _is_write_mode(mode) else _check_read(file)
    return _REAL_OPEN(path, *args, **kwargs)


def _guarded_io_open(file, *args, **kwargs):
    mode = args[0] if args else kwargs.get('mode', 'r')
    path = _check_write(file) if _is_write_mode(mode) else _check_read(file)
    return _REAL_IO_OPEN(path, *args, **kwargs)


def _guarded_socket(*args, **kwargs):
    if not _ALLOW_NETWORK:
        _network_error()
    return _REAL_SOCKET(*args, **kwargs)


def _guarded_chdir(path):
    _check_read(path)
    return _REAL_CHDIR(path)


def _deny_process(*args, **kwargs):
    raise PermissionError('child-process creation is disabled in the sandbox')


def _guard_winapi(module):
    if module is None:
        return
    for _name in ('CreateProcess', 'CreateProcessAsUser'):
        if hasattr(module, _name):
            setattr(module, _name, _deny_process)


def _deny_native_library(*args, **kwargs):
    raise PermissionError('native library loading is disabled in the sandbox')


def _guard_low_level_ctypes(module):
    if module is None:
        return
    for _name in (
        'dlopen', 'LoadLibrary', 'FreeLibrary', 'call_function',
        'call_cdeclfunction', 'PyObj_FromPtr', 'Py_INCREF', 'Py_DECREF',
        'addressof', 'resize',
    ):
        if hasattr(module, _name):
            setattr(module, _name, _deny_native_library)


def _guard_ctypes(module):
    if module is None:
        return
    for _name in (
        'CDLL', 'WinDLL', 'OleDLL', 'PyDLL', '_dlopen', 'pythonapi',
        'memmove', 'memset', 'string_at', 'wstring_at', 'resize', 'cast',
        '_cast', 'addressof',
    ):
        if hasattr(module, _name):
            setattr(module, _name, _deny_native_library)
    for _name in ('cdll', 'windll', 'oledll', 'pydll'):
        _loader = getattr(module, _name, None)
        if _loader is not None and hasattr(_loader, 'LoadLibrary'):
            _loader.LoadLibrary = _deny_native_library
    _guard_low_level_ctypes(sys.modules.get('_ctypes'))


def _guard_winreg(module):
    if module is None:
        return
    allowed_paths = {
        r'software\microsoft\windows nt\currentversion\fonts',
        r'software\microsoft\windows\currentversion\fonts',
        r'software\microsoft\windows\currentversion\explorer\shell folders',
        r'software\microsoft\windows nt\currentversion\time zones',
    }
    allowed_roots = {int(module.HKEY_LOCAL_MACHINE), int(module.HKEY_CURRENT_USER)}
    connected_roots = set()
    allowed_handles = set()
    real_connect_registry = module.ConnectRegistry
    real_open_key = module.OpenKey
    real_query_value_ex = module.QueryValueEx
    real_query_info_key = module.QueryInfoKey
    real_enum_value = module.EnumValue

    def guarded_connect_registry(computer_name, key):
        if computer_name not in (None, '') or int(key) not in allowed_roots:
            raise PermissionError('remote registry access is disabled')
        handle = real_connect_registry(computer_name, key)
        connected_roots.add(int(handle))
        return handle

    def guarded_open_key(key, sub_key, reserved=0, access=None):
        normalized = str(sub_key or '').strip('\\').lower()
        requested_access = module.KEY_READ if access is None else int(access)
        if int(key) not in allowed_roots | connected_roots or normalized not in allowed_paths or requested_access & ~module.KEY_READ:
            raise PermissionError('registry access is limited to Windows font metadata')
        handle = real_open_key(key, sub_key, reserved, requested_access)
        allowed_handles.add(int(handle))
        return handle

    def require_allowed_handle(key):
        if int(key) not in allowed_handles:
            raise PermissionError('registry access is limited to Windows font metadata')

    def guarded_query_value_ex(key, value_name):
        require_allowed_handle(key)
        return real_query_value_ex(key, value_name)

    def guarded_query_info_key(key):
        require_allowed_handle(key)
        return real_query_info_key(key)

    def guarded_enum_value(key, index):
        require_allowed_handle(key)
        return real_enum_value(key, index)

    module.ConnectRegistry = guarded_connect_registry
    module.OpenKey = guarded_open_key
    module.OpenKeyEx = guarded_open_key
    module.QueryValueEx = guarded_query_value_ex
    module.QueryInfoKey = guarded_query_info_key
    module.EnumValue = guarded_enum_value
    for _name in (
        'CreateKey', 'CreateKeyEx', 'DeleteKey', 'DeleteKeyEx',
        'DeleteValue', 'LoadKey', 'SaveKey', 'SetValue', 'SetValueEx', 'QueryValue',
    ):
        if hasattr(module, _name):
            setattr(module, _name, _deny_process)


def _guard_imported_module(name, module):
    if name == '_winapi':
        _guard_winapi(module)
    elif name == 'ctypes':
        _guard_ctypes(module)
    elif name == 'winreg':
        _guard_winreg(module)


_REAL_IMPORT = builtins.__import__
_REAL_IMPORT_MODULE = importlib.import_module
_REAL_CHDIR = os.chdir
_REAL_OS_OPEN = os.open


def _guarded_os_open(file, flags, *args, **kwargs):
    path = _check_write(file) if _is_write_mode(None, flags) else _check_read(file)
    return _REAL_OS_OPEN(path, flags, *args, **kwargs)


def _guarded_listdir(path='.'):
    return _REAL_LISTDIR(_check_read(path))


def _guarded_scandir(path='.'):
    return _REAL_SCANDIR(_check_read(path))


def _guarded_readlink(path, *args, **kwargs):
    return _REAL_READLINK(_check_read(path), *args, **kwargs)


def _guarded_access(path, *args, **kwargs):
    return _REAL_ACCESS(_check_read(path), *args, **kwargs)


_REAL_LISTDIR = os.listdir
_REAL_SCANDIR = os.scandir
_REAL_READLINK = os.readlink
_REAL_ACCESS = os.access


# Scrub inherited credentials before user code or imports can inspect them.
os.environ.clear()
os.environ['PROJECT_ROOT'] = str(PROJECT_ROOT)
os.environ['ALLOW_NETWORK'] = '1' if _ALLOW_NETWORK else '0'
os.environ.update(SAFE_SYSTEM_ENV)
for _variable in ('HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'MPLCONFIGDIR'):
    os.environ[_variable] = str(STAGE_ROOT)

# Keep user site-packages and project-injected import paths out before any
# trusted scientific module is preloaded.
_safe_sys_path = [str(STAGE_ROOT)]
for _entry in sys.path:
    try:
        _candidate = _resolve_path(_entry or Path.cwd())
    except (OSError, TypeError, ValueError):
        continue
    if _under(_candidate, READ_ROOTS) and str(_candidate) not in _safe_sys_path:
        _safe_sys_path.append(str(_candidate))
sys.path[:] = _safe_sys_path


def _preload_supported_libraries():
    os.environ['MPLBACKEND'] = 'Agg'
    for _name in (
        'numpy', 'scipy', 'scipy.linalg', 'pandas',
        'matplotlib', 'matplotlib.pyplot', 'docx',
    ):
        try:
            _REAL_IMPORT_MODULE(_name)
        except Exception as error:
            # Optional modules still report their normal import error if the
            # generated script requests them. Guard installation must proceed.
            if _SANDBOX_DEBUG:
                print(f'preload {_name} failed: {error!r}', file=sys.stderr)
    os.environ.pop('MPLBACKEND', None)


_preload_supported_libraries()
_guard_ctypes(sys.modules.get('ctypes'))
_guard_winreg(sys.modules.get('winreg'))
_guard_winapi(sys.modules.get('_winapi'))

builtins.__import__ = _guarded_import
builtins.open = _guarded_open
io.open = _guarded_io_open
importlib.import_module = _guarded_import_module
socket.socket = _guarded_socket
os.open = _guarded_os_open
os.chdir = _guarded_chdir
os.listdir = _guarded_listdir
os.scandir = _guarded_scandir
os.readlink = _guarded_readlink
os.access = _guarded_access
for _name in ('system', 'popen', 'fork', 'forkpty', 'spawnl', 'spawnle', 'spawnlp', 'spawnlpe', 'spawnv', 'spawnve', 'spawnvp', 'spawnvpe', 'posix_spawn', 'posix_spawnp', 'startfile', 'execl', 'execle', 'execlp', 'execv', 'execve', 'execvp', 'execvpe'):
    if hasattr(os, _name):
        setattr(os, _name, _deny_process)
os.chdir(WORKSPACE_CWD)


if len(sys.argv) < 2:
    print('Usage: sandbox_entry.py <script.py>', file=sys.stderr)
    sys.exit(1)

user_script = _resolve_path(sys.argv[1])
_check_read(user_script)
if user_script != PROJECT_ROOT and PROJECT_ROOT not in user_script.parents:
    raise PermissionError('script outside workspace')
sys.argv = sys.argv[1:]
with _REAL_OPEN(user_script, 'r', encoding='utf-8') as handle:
    source = handle.read()

# The guard itself starts as Python's __main__ module. Replace that registry
# entry before executing untrusted code so `import __main__` resolves only to
# the user module and cannot expose the guard's privileged implementation
# details. Process-wide audit hooks remain the enforcement boundary even when
# code obtains an original audited callable through Python introspection.
user_module = types.ModuleType('__main__')
user_module.__file__ = str(user_script)
user_module.__package__ = None
sys.modules['__main__'] = user_module
exec(compile(source, str(user_script), 'exec'), user_module.__dict__, user_module.__dict__)
