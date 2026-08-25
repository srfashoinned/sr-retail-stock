param(
  [string]$LocalFolder = "E:\New Website",
  [string]$RemoteFolder = "/public_html"
)

$ErrorActionPreference = "Stop"

$hostName = $env:HOSTINGER_FTP_HOST
$userName = $env:HOSTINGER_FTP_USER
$password = $env:HOSTINGER_FTP_PASSWORD

if ([string]::IsNullOrWhiteSpace($hostName) -or
    [string]::IsNullOrWhiteSpace($userName) -or
    [string]::IsNullOrWhiteSpace($password)) {
  throw "Set HOSTINGER_FTP_HOST, HOSTINGER_FTP_USER, and HOSTINGER_FTP_PASSWORD before uploading."
}

function New-FtpDirectory {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  $parts = $Path.Trim("/").Split("/") | Where-Object { $_ }
  $current = ""

  foreach ($part in $parts) {
    $current = if ($current) { "$current/$part" } else { $part }
    $uri = "ftp://$hostName/$current"

    $request = [System.Net.FtpWebRequest]::Create($uri)
    $request.Method = [System.Net.WebRequestMethods+Ftp]::MakeDirectory
    $request.Credentials = [System.Net.NetworkCredential]::new($userName, $password)
    try {
      $response = $request.GetResponse()
      $response.Close()
    }
    catch {
      # Existing folders usually return an FTP error. That is fine.
    }
  }
}

function Send-FtpFile {
  param(
    [string]$LocalPath,
    [string]$RelativePath
  )

  $remotePath = ($RemoteFolder.TrimEnd("/") + "/" + $RelativePath.Replace("\", "/"))
  $remoteDir = Split-Path -Parent $remotePath
  New-FtpDirectory -Path $remoteDir

  $uri = "ftp://$hostName$remotePath"
  Write-Host "Uploading $RelativePath to Hostinger..."

  $client = [System.Net.WebClient]::new()
  try {
    $client.Credentials = [System.Net.NetworkCredential]::new($userName, $password)
    $client.UploadFile($uri, [System.Net.WebRequestMethods+Ftp]::UploadFile, $LocalPath) | Out-Null
  }
  finally {
    $client.Dispose()
  }
}

$requiredFiles = @(
  "index.html",
  "items.json",
  "CNAME"
)

foreach ($file in $requiredFiles) {
  $localPath = Join-Path $LocalFolder $file
  if (Test-Path -LiteralPath $localPath) {
    Send-FtpFile -LocalPath $localPath -RelativePath $file
  }
}

$requiredFolders = @(
  "image-api",
  "images"
)

foreach ($folder in $requiredFolders) {
  $folderPath = Join-Path $LocalFolder $folder
  if (-not (Test-Path -LiteralPath $folderPath)) { continue }

  Get-ChildItem -LiteralPath $folderPath -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($LocalFolder.Length).TrimStart("\", "/")
    if ($relative -match '(^|[\\/])private([\\/]|$)') { return }
    Send-FtpFile -LocalPath $_.FullName -RelativePath $relative
  }
}

Write-Host "Hostinger upload complete."
