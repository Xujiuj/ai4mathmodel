#!/usr/bin/env python3
import ast
import sys

FORBIDDEN_CALLS = {
    ('os', 'system'), ('os', 'popen'), ('os', 'remove'), ('os', 'rmdir'), ('os', 'unlink'),
    ('os', 'fork'), ('os', 'startfile'), ('os', 'posix_spawn'), ('os', 'posix_spawnp'),
    ('shutil', 'rmtree'), ('shutil', 'move'),
    ('subprocess', 'run'), ('subprocess', 'Popen'), ('subprocess', 'call'),
    ('socket', 'socket'), ('pip', 'main'), ('importlib', 'import_module'),
}
FORBIDDEN_BUILTINS = {'eval', 'exec', 'compile', '__import__'}
FORBIDDEN_MODULES = {
    'builtins', 'ctypes', '_ctypes', '_winapi', 'os', 'shutil', 'sys', 'winreg', 'multiprocessing', 'socket', 'subprocess', 'pip',
    'requests', 'urllib', 'http', 'ftplib', 'telnetlib', 'importlib',
}


def _bound_name(alias):
    """Return the name introduced by an import alias."""
    return alias.asname or alias.name.split('.')[0]


class ForbiddenPatternDetector(ast.NodeVisitor):
    def __init__(self):
        self.violations = []
        self.module_aliases = {}
        self.call_aliases = {}

    def visit_Import(self, node):
        for alias in node.names:
            module = alias.name.split('.')[0]
            bound = _bound_name(alias)
            if module in FORBIDDEN_MODULES:
                self.module_aliases[bound] = module
                self.violations.append(f'Line {node.lineno}: Forbidden module import: {alias.name}')
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        module = node.module.split('.')[0] if node.module else ''
        if module in FORBIDDEN_MODULES:
            self.violations.append(f'Line {node.lineno}: Forbidden module import: {node.module}')
            for alias in node.names:
                bound = alias.asname or alias.name
                if alias.name == '*':
                    continue
                self.call_aliases[bound] = (module, alias.name)
        self.generic_visit(node)

    def visit_Assign(self, node):
        # Preserve the policy through simple aliases such as
        # ``remove_file = os.remove`` and ``run_process = execute``.
        value = node.value
        if isinstance(value, ast.Attribute) and isinstance(value.value, ast.Name):
            module = self.module_aliases.get(value.value.id, value.value.id)
            if module in FORBIDDEN_MODULES:
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        self.call_aliases[target.id] = (module, value.attr)
        elif isinstance(value, ast.Name) and value.id in self.call_aliases:
            for target in node.targets:
                if isinstance(target, ast.Name):
                    self.call_aliases[target.id] = self.call_aliases[value.id]
        self.generic_visit(node)

    def visit_Call(self, node):
        if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
            module = self.module_aliases.get(node.func.value.id, node.func.value.id)
            pair = (module, node.func.attr)
            if pair in FORBIDDEN_CALLS:
                self.violations.append(f'Line {node.lineno}: Forbidden call: {pair[0]}.{pair[1]}')
        if isinstance(node.func, ast.Name):
            if node.func.id in FORBIDDEN_BUILTINS:
                self.violations.append(f'Line {node.lineno}: Forbidden builtin: {node.func.id}')
            elif node.func.id in self.call_aliases:
                module, name = self.call_aliases[node.func.id]
                if (module, name) in FORBIDDEN_CALLS:
                    self.violations.append(f'Line {node.lineno}: Forbidden call: {module}.{name}')
        self.generic_visit(node)


def scan_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as handle:
        source = handle.read()
    try:
        tree = ast.parse(source, filename=filepath)
    except SyntaxError as error:
        return [f'Syntax error: {error}']
    detector = ForbiddenPatternDetector()
    detector.visit(tree)
    return detector.violations


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('Usage: scan.py <script.py>', file=sys.stderr)
        sys.exit(1)
    violations = scan_file(sys.argv[1])
    if violations:
        print('代码包含禁止的调用或模块:', file=sys.stderr)
        for item in violations:
            print(f'  {item}', file=sys.stderr)
        sys.exit(1)
    print('静态检查通过')
    sys.exit(0)
