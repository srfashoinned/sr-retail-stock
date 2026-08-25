<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function sr_json(int $status, array $payload): void {
  http_response_code($status);
  echo json_encode($payload, JSON_UNESCAPED_SLASHES);
  exit;
}

function sr_alias(?string $value): string {
  return preg_replace('/[^a-zA-Z0-9_-]/', '', trim((string)$value));
}

function sr_key(): string {
  $env = getenv('SR_IMAGE_UPLOAD_KEY');
  if ($env !== false && trim($env) !== '') return trim($env);
  $file = dirname(__DIR__) . '/private/image-upload-key.txt';
  return is_file($file) ? trim((string)file_get_contents($file)) : '';
}

function sr_require_key(): void {
  $given = $_SERVER['HTTP_X_SR_IMAGE_KEY'] ?? '';
  $key = sr_key();
  if ($key === '' || !hash_equals($key, $given)) {
    sr_json(403, ['ok' => false, 'error' => 'Image upload password required']);
  }
}

function sr_image_dir(string $alias): string {
  return dirname(__DIR__) . '/images/products/' . $alias;
}

function sr_image_url(string $alias, string $name): string {
  return '/images/products/' . rawurlencode($alias) . '/' . rawurlencode($name) . '?v=' . @filemtime(sr_image_dir($alias) . '/' . $name);
}

function sr_images(string $alias): array {
  $dir = sr_image_dir($alias);
  if (!is_dir($dir)) return [];
  $files = array_values(array_filter(scandir($dir) ?: [], fn($name) => preg_match('/\.(jpe?g|png|webp|gif)$/i', $name)));
  natsort($files);
  return array_map(fn($name) => ['name' => $name, 'url' => sr_image_url($alias, $name)], array_values($files));
}
?>
