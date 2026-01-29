# Full Backup Script for FreezerIQ App (PostgreSQL)
# Creates backup of database and code

$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$backupDir = "backups/backup_$timestamp"

Write-Host "Creating backup: $backupDir" -ForegroundColor Green

# Create backup directory structure
New-Item -ItemType Directory -Force -Path "$backupDir/database" | Out-Null
New-Item -ItemType Directory -Force -Path "$backupDir/code" | Out-Null

# Export PostgreSQL database
Write-Host "Exporting PostgreSQL database..." -ForegroundColor Yellow

$dbFile = "$backupDir/database/freezeriq_backup.sql"

# Use pg_dump to export database
$env:PGPASSWORD = "postgres"
try {
    & pg_dump -h localhost -p 5432 -U postgres -d freezer_iq -f $dbFile 2>&1 | Out-Null
    if (Test-Path $dbFile) {
        Write-Host "Database exported successfully" -ForegroundColor Green
    }
    else {
        Write-Host "Database export may have failed" -ForegroundColor Yellow
    }
}
catch {
    Write-Host "pg_dump not found or failed. Skipping database backup." -ForegroundColor Yellow
    Write-Host "Install PostgreSQL tools or run manually: pg_dump -h localhost -U postgres freezer_iq > backup.sql" -ForegroundColor Gray
}

# Backup code files
Write-Host "Backing up code files..." -ForegroundColor Yellow

# Copy important directories
$dirs = @("app", "components", "lib", "prisma", "scripts", "public")
foreach ($dir in $dirs) {
    if (Test-Path $dir) {
        Copy-Item -Path $dir -Destination "$backupDir/code/" -Recurse -Force
        Write-Host "  Copied $dir" -ForegroundColor Gray
    }
}

# Copy root config files
$rootFiles = @("package.json", "package-lock.json", "tsconfig.json", "next.config.js", "tailwind.config.js", "postcss.config.js", ".env.example")
foreach ($file in $rootFiles) {
    if (Test-Path $file) {
        Copy-Item -Path $file -Destination "$backupDir/code/" -Force
    }
}

Write-Host "Code files backed up" -ForegroundColor Green

# Create backup manifest
$dbSize = 0
if (Test-Path $dbFile) {
    $dbSize = (Get-Item $dbFile).Length
}

$codeFiles = (Get-ChildItem -Path "$backupDir/code" -Recurse -File).Count

$manifest = @{
    timestamp     = $timestamp
    database_type = "PostgreSQL"
    database_size = $dbSize
    code_files    = $codeFiles
    backup_path   = $backupDir
}

$manifest | ConvertTo-Json | Out-File "$backupDir/manifest.json"

Write-Host ""
Write-Host "========================================"  -ForegroundColor Cyan
Write-Host "Backup Complete!" -ForegroundColor Green
Write-Host "Location: $backupDir" -ForegroundColor Cyan
Write-Host "Database: $dbSize bytes" -ForegroundColor Cyan
Write-Host "Code Files: $codeFiles" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
