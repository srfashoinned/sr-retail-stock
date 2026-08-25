<?php
require __DIR__ . '/_common.php';

$alias = sr_alias($_GET['alias'] ?? '');
if ($alias === '') sr_json(400, ['ok' => false, 'error' => 'Missing product code']);

sr_json(200, ['ok' => true, 'images' => sr_images($alias)]);
?>
