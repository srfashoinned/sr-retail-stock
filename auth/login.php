<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  http_response_code(204);
  exit;
}

function sr_auth_json(int $status, array $payload): void {
  http_response_code($status);
  echo json_encode($payload, JSON_UNESCAPED_SLASHES);
  exit;
}

function sr_auth_private(string $file): string {
  return dirname(__DIR__) . '/private/' . $file;
}

function sr_auth_hash(string $pin, string $salt): string {
  return hash('sha256', $salt . ':' . $pin);
}

function sr_auth_role(string $pin): string {
  $file = sr_auth_private('access-keys.json');
  if (!is_file($file)) return '';
  $data = json_decode((string)file_get_contents($file), true);
  if (!is_array($data)) return '';
  $salt = (string)($data['salt'] ?? '');
  if ($salt === '') return '';
  $digest = sr_auth_hash($pin, $salt);
  if (!empty($data['adminHash']) && hash_equals((string)$data['adminHash'], $digest)) return 'admin';
  if (!empty($data['staffHash']) && hash_equals((string)$data['staffHash'], $digest)) return 'staff';
  return '';
}

function sr_auth_sessions(): array {
  $file = sr_auth_private('upload-sessions.json');
  if (!is_file($file)) return [];
  $data = json_decode((string)file_get_contents($file), true);
  return is_array($data) ? $data : [];
}

function sr_auth_save_sessions(array $sessions): void {
  $file = sr_auth_private('upload-sessions.json');
  $dir = dirname($file);
  if (!is_dir($dir)) mkdir($dir, 0755, true);
  file_put_contents($file, json_encode($sessions, JSON_UNESCAPED_SLASHES));
}

function sr_auth_make_session(string $role): string {
  $now = time();
  $sessions = array_filter(sr_auth_sessions(), fn($row) => is_array($row) && (int)($row['expiresAt'] ?? 0) > $now);
  $token = $role . '.' . bin2hex(random_bytes(24));
  $sessions[$token] = ['role' => $role, 'expiresAt' => $now + 12 * 60 * 60];
  sr_auth_save_sessions($sessions);
  return $token;
}

$raw = file_get_contents('php://input');
$body = json_decode($raw ?: '{}', true) ?: [];
$pin = trim((string)($body['pin'] ?? ''));
if (strlen($pin) < 3) sr_auth_json(400, ['ok' => false, 'error' => 'PIN required']);

$role = sr_auth_role($pin);
if ($role === '') sr_auth_json(403, ['ok' => false, 'error' => 'Wrong PIN']);

sr_auth_json(200, ['ok' => true, 'role' => $role, 'imageKey' => sr_auth_make_session($role)]);
?>
