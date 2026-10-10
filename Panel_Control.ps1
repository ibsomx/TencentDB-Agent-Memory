$scriptDir = $PSScriptRoot
$dataDir = Join-Path $scriptDir "MemoryKnowledge\data\local\local"
$apiUrl = "http://127.0.0.1:8421/v3/code-graph/create"
$configPath = Join-Path $scriptDir "panel_config.txt"
$namesFile = Join-Path $scriptDir "nombres_proyectos.json"
$desktopPath = [Environment]::GetFolderPath("Desktop")

function Get-Names {
    if (Test-Path $namesFile) {
        try { return (Get-Content $namesFile -Raw) | ConvertFrom-Json -AsHashtable } catch { return @{} }
    }
    return @{}
}

function Save-Names ($hash) {
    $hash | ConvertTo-Json | Set-Content $namesFile
}

function Show-Menu {
    Clear-Host
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host "   PANEL DE CONTROL - TENCENTDB AGENT MEMORY            " -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "1. Ver, seleccionar y NOMBRAR proyectos guardados"
    Write-Host "2. Crear NUEVO proyecto (pide nombre y genera carpeta)"
    Write-Host "3. Guardar un proyecto EXISTENTE (arrastrar carpeta)"
    Write-Host "4. Capturar 'Proyecto Vivo' de los agentes CLI"
    Write-Host "5. Salir"
    Write-Host ""
    $choice = Read-Host "Elige una opcion (1-5)"
    return $choice
}

function List-Projects {
    Clear-Host
    Write-Host "--- PROYECTOS GUARDADOS ---" -ForegroundColor Yellow
    if (-not (Test-Path $dataDir)) {
        Write-Host "No se encontro el directorio de datos. Asegurate de ingestar un proyecto primero." -ForegroundColor Red
        pause
        return
    }
    
    $projects = Get-ChildItem -Path $dataDir -Directory | Where-Object { $_.Name -match "^cg-" }
    if ($projects.Count -eq 0) {
        Write-Host "No hay proyectos guardados todavia." -ForegroundColor Gray
        pause
        return
    }
    
    $names = Get-Names
    $i = 1
    foreach ($p in $projects) {
        $id = $p.Name
        $friendly = if ($names.ContainsKey($id)) { $names[$id] } else { "(Sin nombre)" }
        Write-Host "$i. $id -> $friendly"
        $i++
    }
    Write-Host "---------------------------"
    Write-Host "0. Volver al menu"
    Write-Host "R. Ponerle un nombre a un proyecto"
    Write-Host ""
    
    $sel = Read-Host "Ingresa el NUMERO para copiar su ID, o 'R' para renombrar"
    if ($sel -eq 'R' -or $sel -eq 'r') {
        $n = Read-Host "Que numero de proyecto quieres nombrar? (ej. 1)"
        if ($n -match "^\d+$" -and [int]$n -le $projects.Count -and [int]$n -gt 0) {
            $id = $projects[[int]$n - 1].Name
            $newName = Read-Host "Escribe el nombre para $id"
            $names[$id] = $newName
            Save-Names $names
            Write-Host "Nombre guardado con exito." -ForegroundColor Green
            pause
        }
        return
    }
    
    if ($sel -ne "0" -and $sel -match "^\d+$" -and [int]$sel -le $projects.Count -and [int]$sel -gt 0) {
        $selectedId = $projects[[int]$sel - 1].Name
        Set-Clipboard -Value $selectedId
        $friendlyName = if ($names.ContainsKey($selectedId)) { $names[$selectedId] } else { "(Sin nombre)" }
        Write-Host ""
        Write-Host "=================================================" -ForegroundColor Green
        Write-Host " EXITO: El proyecto '$friendlyName' fue seleccionado!" -ForegroundColor Green
        Write-Host " ID '$selectedId' copiado al portapapeles." -ForegroundColor Green
        Write-Host "=================================================" -ForegroundColor Green
        pause
    }
}

function Do-Ingest($folderPath, $projectName="") {
    $folderPath = $folderPath -replace "\\", "/"
    $repoUrl = "file:///$folderPath"
    Write-Host "
Ingestando proyecto en el motor... Por favor espera." -ForegroundColor Cyan
    try {
        $body = @{ repo_url = $repoUrl; branch = "main"; team_id = "local" } | ConvertTo-Json
        $response = Invoke-RestMethod -Method Post -Uri $apiUrl -Headers @{'x-tdai-service-id'='local'; 'Content-Type'='application/json'} -Body $body
        if ($response.code -eq 0) {
            $newId = $response.data.code_graph_id
            if (-not [string]::IsNullOrWhiteSpace($projectName)) {
                $names = Get-Names
                $names[$newId] = $projectName
                Save-Names $names
            }
            Set-Clipboard -Value $newId
            Write-Host "
=================================================" -ForegroundColor Green
            Write-Host " EXITO: Proyecto indexado exitosamente en Memoria!" -ForegroundColor Green
            Write-Host " ID: $newId (Copiado al portapapeles)" -ForegroundColor Green
            Write-Host "=================================================" -ForegroundColor Green
        } else { Write-Host "Error del motor: $($response.message)" -ForegroundColor Red }
    } catch {
        Write-Host "Error de conexion. Asegurate de que el motor este corriendo." -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
    }
    pause
}

function Create-Project {
    Clear-Host
    Write-Host "--- CREAR NUEVO PROYECTO ---" -ForegroundColor Yellow
    $name = Read-Host "Ingresa el nombre del nuevo proyecto"
    if ([string]::IsNullOrWhiteSpace($name)) { return }
    $folderPath = Join-Path $desktopPath $name
    if (-not (Test-Path $folderPath)) {
        New-Item -Path $folderPath -ItemType Directory -Force | Out-Null
        Write-Host "Carpeta creada en: $folderPath" -ForegroundColor Green
    } else { Write-Host "La carpeta ya existe. Procediendo a ingestarla." -ForegroundColor Yellow }
    Do-Ingest $folderPath $name
}

function Existing-Project {
    Clear-Host
    Write-Host "--- INGESTAR PROYECTO EXISTENTE ---" -ForegroundColor Yellow
    Write-Host "Arrastra la carpeta a esta ventana y presiona Enter."
    $folderPath = Read-Host "Ruta"
    $folderPath = $folderPath -replace '"', ''
    if (-not (Test-Path $folderPath)) { Write-Host "Ruta no valida." -ForegroundColor Red; pause; return }
    $name = Read-Host "Dale un nombre a este proyecto para recordarlo (opcional)"
    Do-Ingest $folderPath $name
}

function Live-Project {
    Clear-Host
    Write-Host "--- CAPTURAR PROYECTO VIVO (AGENTES CLI) ---" -ForegroundColor Yellow
    $rutasSugeridas = @($desktopPath)
    if (Test-Path $configPath) {
        $saved = Get-Content $configPath
        if (-not [string]::IsNullOrWhiteSpace($saved) -and $rutasSugeridas -notcontains $saved) { $rutasSugeridas = @($saved) + $rutasSugeridas }
    }
    Write-Host "Selecciona la carpeta que estan usando las IAs:"
    $i = 1
    foreach ($r in $rutasSugeridas) { Write-Host "$i. $r"; $i++ }
    Write-Host "O. Ingresar / Arrastrar una ruta diferente..."
    Write-Host "C. Cancelar
"
    $sel = Read-Host "Elige una opcion"
    if ($sel -eq 'C' -or $sel -eq 'c') { return }
    $livePath = ""
    if ($sel -match "^\d+$" -and [int]$sel -le $rutasSugeridas.Count -and [int]$sel -gt 0) {
        $livePath = $rutasSugeridas[[int]$sel - 1]
    } elseif ($sel -eq 'O' -or $sel -eq 'o') {
        $livePath = Read-Host "Ingresa o arrastra la nueva ruta"
        $livePath = $livePath -replace '"', ''
    } else { return }
    if ([string]::IsNullOrWhiteSpace($livePath) -or -not (Test-Path $livePath)) { Write-Host "Ruta no valida." -ForegroundColor Red; pause; return }
    Set-Content -Path $configPath -Value $livePath
    Write-Host "
Sincronizando estado en vivo desde: $livePath" -ForegroundColor Green
    Do-Ingest $livePath "Workspace CLI en vivo"
}

while ($true) {
    $c = Show-Menu
    if ($c -eq '1') { List-Projects }
    elseif ($c -eq '2') { Create-Project }
    elseif ($c -eq '3') { Existing-Project }
    elseif ($c -eq '4') { Live-Project }
    elseif ($c -eq '5') { break }
}
