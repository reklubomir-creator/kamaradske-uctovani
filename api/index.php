<?php
declare(strict_types=1);

/**
 * Kamarádské účtování — PHP + MariaDB JSON API.
 *
 * GET  ?action=read&token=...      Read a shared group.
 * POST {"action":"create","name":"..."} Create a group.
 * POST {"action":"save","token":"...","data":{...}} Save group data.
 * POST {"action":"delete","token":"...","ownerKey":"..."} Delete a group.
 *
 * The access token intentionally grants read/write access for sharing.
 * Deletion additionally requires the separate owner key.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function respond(array $body, int $status = 200): never {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    respond(['ok' => false, 'error' => 'API is not configured.'], 500);
}
$config = require $configPath;

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$allowedOrigins = $config['allowed_origins'] ?? [];
if (!is_array($allowedOrigins)) {
    respond(['ok' => false, 'error' => 'API configuration is invalid.'], 500);
}

/*
 * Browser requests must come from an explicitly configured origin.
 * Requests without Origin are allowed for server-to-server tools and tests;
 * browser cross-origin requests cannot normally omit this header.
 */
if ($origin !== '' && !in_array($origin, $allowedOrigins, true)) {
    respond(['ok' => false, 'error' => 'Origin not allowed.'], 403);
}
if ($origin !== '') {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
}
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') {
    if ($origin === '') {
        respond(['ok' => false, 'error' => 'Origin required for preflight.'], 400);
    }
    http_response_code(204);
    exit;
}

function randomHex(int $bytes = 32): string {
    return bin2hex(random_bytes($bytes));
}

function uuidV4(): string {
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    $hex = bin2hex($bytes);
    return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' .
        substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20, 12);
}

function readJsonBody(int $maxBytes = 524288): array {
    $length = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($length > $maxBytes) {
        respond(['ok' => false, 'error' => 'Request body is too large.'], 413);
    }
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > $maxBytes) {
        respond(['ok' => false, 'error' => 'Request body is too large or unreadable.'], 413);
    }
    $input = json_decode($raw, true);
    if (!is_array($input) || json_last_error() !== JSON_ERROR_NONE) {
        respond(['ok' => false, 'error' => 'Request body must be valid JSON.'], 400);
    }
    return $input;
}

if (!in_array($method, ['GET', 'POST'], true)) {
    header('Allow: GET, POST, OPTIONS');
    respond(['ok' => false, 'error' => 'Method not allowed.'], 405);
}

if ($method === 'GET') {
    $action = (string)($_GET['action'] ?? '');
    if ($action !== 'read') {
        respond(['ok' => false, 'error' => 'Unknown action. Use POST to create or modify groups.'], 405);
    }
    $token = (string)($_GET['token'] ?? '');
    if ($token === '' || strlen($token) > 200) {
        respond(['ok' => false, 'error' => 'Missing or invalid token.'], 400);
    }
}

$input = $method === 'POST' ? readJsonBody() : [];
$action = $method === 'GET' ? 'read' : (string)($input['action'] ?? '');

if ($method === 'POST') {
    $contentType = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
    if ($contentType !== 'application/json') {
        respond(['ok' => false, 'error' => 'Content-Type must be application/json.'], 415);
    }
    if (!in_array($action, ['create', 'save', 'delete'], true)) {
        respond(['ok' => false, 'error' => 'Unknown action.'], 400);
    }
}

try {
    $pdo = new PDO(
        'mysql:host=' . $config['db_host'] . ';dbname=' . $config['db_name'] . ';charset=utf8mb4',
        $config['db_user'],
        $config['db_password'],
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );
} catch (Throwable $e) {
    error_log('KU API database connection failed: ' . $e->getMessage());
    respond(['ok' => false, 'error' => 'Database connection failed.'], 500);
}

if ($action === 'read') {
    $token = (string)($_GET['token'] ?? '');
    $stmt = $pdo->prepare('SELECT id, name, data_json FROM groups WHERE access_token = ? LIMIT 1');
    $stmt->execute([$token]);
    $row = $stmt->fetch();
    if (!$row) respond(['ok' => false, 'error' => 'Group not found.'], 404);
    $data = json_decode($row['data_json'], true);
    if (!is_array($data)) $data = [];
    respond(['ok' => true, 'group' => [
        'id' => $row['id'],
        'name' => $row['name'],
        'data' => $data,
    ]]);
}

if ($action === 'create') {
    $name = trim((string)($input['name'] ?? 'Nová skupina'));
    if ($name === '') $name = 'Nová skupina';
    if (mb_strlen($name) > 190) respond(['ok' => false, 'error' => 'Group name is too long.'], 400);
    $id = uuidV4();
    $token = randomHex(36);
    $ownerKey = randomHex(32);
    $data = ['name' => $name, 'people' => [], 'expenses' => [], 'notes' => []];
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) respond(['ok' => false, 'error' => 'Could not encode group data.'], 400);
    $stmt = $pdo->prepare('INSERT INTO groups (id, access_token, owner_key_hash, name, data_json) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$id, $token, hash('sha256', $ownerKey), $name, $json]);
    respond(['ok' => true, 'group' => ['id' => $id, 'name' => $name, 'token' => $token, 'ownerKey' => $ownerKey, 'data' => $data]], 201);
}

$token = (string)($input['token'] ?? '');
if ($token === '' || strlen($token) > 200) {
    respond(['ok' => false, 'error' => 'Missing or invalid token.'], 400);
}

if ($action === 'save') {
    $data = $input['data'] ?? null;
    if (!is_array($data)) respond(['ok' => false, 'error' => 'Missing group data.'], 400);
    $name = trim((string)($data['name'] ?? 'Sdílená skupina'));
    if ($name === '') $name = 'Sdílená skupina';
    if (mb_strlen($name) > 190) respond(['ok' => false, 'error' => 'Group name is too long.'], 400);
    $data['name'] = $name;
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) respond(['ok' => false, 'error' => 'Could not encode group data.'], 400);
    if (strlen($json) > 524288) respond(['ok' => false, 'error' => 'Group data is too large.'], 413);

    $stmt = $pdo->prepare('UPDATE groups SET name = ?, data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE access_token = ?');
    $stmt->execute([$name, $json, $token]);
    if ($stmt->rowCount() === 0) {
        $check = $pdo->prepare('SELECT id FROM groups WHERE access_token = ?');
        $check->execute([$token]);
        if (!$check->fetch()) respond(['ok' => false, 'error' => 'Group not found.'], 404);
    }
    respond(['ok' => true]);
}

if ($action === 'delete') {
    $ownerKey = (string)($input['ownerKey'] ?? '');
    if ($ownerKey === '' || strlen($ownerKey) > 200) {
        respond(['ok' => false, 'error' => 'Owner confirmation is required to delete this group.'], 403);
    }
    $stmt = $pdo->prepare('SELECT owner_key_hash FROM groups WHERE access_token = ? LIMIT 1');
    $stmt->execute([$token]);
    $row = $stmt->fetch();
    if (!$row) respond(['ok' => false, 'error' => 'Group not found.'], 404);
    if (!hash_equals((string)$row['owner_key_hash'], hash('sha256', $ownerKey))) {
        respond(['ok' => false, 'error' => 'Owner confirmation is invalid.'], 403);
    }
    $delete = $pdo->prepare('DELETE FROM groups WHERE access_token = ?');
    $delete->execute([$token]);
    respond(['ok' => true]);
}

respond(['ok' => false, 'error' => 'Unknown action.'], 400);
