<?php
require __DIR__ . '/_common.php';
sr_require_key();

$alias = sr_alias($_POST['alias'] ?? '');
if ($alias === '' || !isset($_FILES['file'])) sr_json(400, ['ok' => false, 'error' => 'Missing image']);
if ($_FILES['file']['error'] !== UPLOAD_ERR_OK) sr_json(400, ['ok' => false, 'error' => 'Upload failed']);
if ($_FILES['file']['size'] > 9 * 1024 * 1024) sr_json(400, ['ok' => false, 'error' => 'Image too large']);

$info = @getimagesize($_FILES['file']['tmp_name']);
$mime = $info['mime'] ?? '';
if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], true)) {
  sr_json(400, ['ok' => false, 'error' => 'Only image files allowed']);
}

$dir = sr_image_dir($alias);
if (!is_dir($dir) && !mkdir($dir, 0755, true)) sr_json(500, ['ok' => false, 'error' => 'Cannot create image folder']);

$used = [];
foreach (sr_images($alias) as $image) $used[(int)$image['name']] = true;
$num = 1;
while (isset($used[$num])) $num++;
if ($num > 10) sr_json(400, ['ok' => false, 'error' => 'Max 10 images reached']);

$name = $num . '.jpg';
$target = $dir . '/' . $name;
if (!move_uploaded_file($_FILES['file']['tmp_name'], $target)) sr_json(500, ['ok' => false, 'error' => 'Could not save image']);
@chmod($target, 0644);

sr_json(200, ['ok' => true, 'image' => ['name' => $name, 'url' => sr_image_url($alias, $name)]]);
?>
