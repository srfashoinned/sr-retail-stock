<?php
require __DIR__ . '/_common.php';
sr_require_key();

$raw = file_get_contents('php://input');
$body = json_decode($raw ?: '{}', true) ?: [];
$alias = sr_alias($body['alias'] ?? '');
$name = preg_replace('/[^a-zA-Z0-9_.-]/', '', (string)($body['name'] ?? ''));
if ($alias === '' || !preg_match('/^\d+\.(jpe?g|png|webp|gif)$/i', $name)) {
  sr_json(400, ['ok' => false, 'error' => 'Invalid image']);
}

$file = sr_image_dir($alias) . '/' . $name;
if (is_file($file)) unlink($file);
sr_json(200, ['ok' => true]);
?>
