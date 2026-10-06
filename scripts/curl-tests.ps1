param(
  # The deployed Worker. Override with -Base to point somewhere else.
  [string]$Base = "https://faculty-equipment-booking.taskflow-123.workers.dev/api"
)

# Evidence suite for the lab test.
#
#   npm run db:seed:remote     # start from a clean bookings table
#   pwsh scripts/curl-tests.ps1
#
# Prints PASS/FAIL per case with the status code and body, then a summary.
# Exit code is non-zero if any case fails.

$ErrorActionPreference = 'Stop'
$script:Base = $Base
$script:case = 0
$script:fails = 0
$bodyFile = Join-Path $env:TEMP 'labtest-body.txt'

function Invoke-Api {
  param(
    [string]$Label,
    [string]$Method,
    [string]$Path,
    [string]$Json,
    [int]$Expect,
    [string]$ExpectText,
    [switch]$ExpectEmpty,
    # Only the cases that need a created id ask for the return value;
    # everything else stays off the pipeline so output is not echoed twice.
    [switch]$PassThru
  )

  $script:case++
  # Remove the previous case's body first so a failed write can never be
  # mistaken for this case's response.
  Remove-Item $bodyFile -ErrorAction SilentlyContinue
  $curlArgs = @('-s', '-X', $Method, '-o', $bodyFile, '-w', '%{http_code}', "$script:Base$Path")
  if ($Json) {
    $curlArgs += @('-H', 'Content-Type: application/json', '-d', $Json)
  }

  $status = (& curl.exe @curlArgs)
  # -Raw returns $null for a zero-byte body (204), so coerce before trimming.
  $raw = if (Test-Path $bodyFile) { Get-Content $bodyFile -Raw } else { $null }
  $body = if ($null -eq $raw) { '' } else { $raw.Trim() }

  $ok = ("$status" -eq "$Expect")
  if ($ok -and $ExpectText) { $ok = $body.Contains($ExpectText) }
  if ($ok -and $ExpectEmpty) { $ok = ($body -eq '') }
  if (-not $ok) { $script:fails++ }

  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  # Write-Host, not Write-Output: the caller captures this function's pipeline
  # output as the response body, so display must stay off the pipeline.
  Write-Host "[$mark] #$script:case $Label"
  Write-Host "       $Method $Path -> HTTP $status (expected $Expect)"
  if ($ExpectText) { Write-Host "       expected text: $ExpectText" }
  if ($ExpectEmpty) { Write-Host "       expected body: (empty)" }
  Write-Host "       $body"
  Write-Host ''
  if ($PassThru) { return $body }
}

$createA = @'
{"equipmentId":"eq-1","borrowerName":"Somchai Jaidee","startAt":"2026-10-20T09:00:00.000Z","endAt":"2026-10-20T11:00:00.000Z","purpose":"Class presentation"}
'@

# --- Happy paths -----------------------------------------------------------

Invoke-Api 'List equipment (two seeded records)' GET '/equipment' $null 200 'eq-1'

Invoke-Api 'Bookings table is empty after seed' GET '/bookings' $null 200 '[]'

$created = Invoke-Api 'PART 7: create a booking' POST '/bookings' $createA 201 '"equipmentId":"eq-1"' -PassThru
$a = ($created | ConvertFrom-Json).id

Invoke-Api 'Get one booking by id' GET "/bookings/$a" $null 200 'Somchai Jaidee'

Invoke-Api 'List now contains the booking' GET '/bookings' $null 200 $a

# --- Validation 1: equipment must exist ------------------------------------

Invoke-Api 'Validation 1: unknown equipmentId' POST '/bookings' `
  '{"equipmentId":"eq-999","borrowerName":"X","startAt":"2026-10-25T09:00:00.000Z","endAt":"2026-10-25T10:00:00.000Z","purpose":"p"}' `
  404 'Equipment not found'

# --- Validation 2: startAt < endAt (timestamps parsed) ---------------------

Invoke-Api 'Validation 2: reversed range 11:00 -> 09:00' POST '/bookings' `
  '{"equipmentId":"eq-1","borrowerName":"X","startAt":"2026-10-20T11:00:00.000Z","endAt":"2026-10-20T09:00:00.000Z","purpose":"p"}' `
  400 'startAt must be before endAt'

Invoke-Api 'Validation 2: equal timestamps 09:00 -> 09:00' POST '/bookings' `
  '{"equipmentId":"eq-1","borrowerName":"X","startAt":"2026-10-20T09:00:00.000Z","endAt":"2026-10-20T09:00:00.000Z","purpose":"p"}' `
  400 'startAt must be before endAt'

Invoke-Api 'Validation 2: unparseable timestamp' POST '/bookings' `
  '{"equipmentId":"eq-1","borrowerName":"X","startAt":"yesterday","endAt":"2026-10-20T09:00:00.000Z","purpose":"p"}' `
  400 'startAt must be before endAt'

# --- Validation 3: no overlap for the same equipment -----------------------

Invoke-Api 'Validation 3: overlapping 10:00 -> 12:00' POST '/bookings' `
  '{"equipmentId":"eq-1","borrowerName":"X","startAt":"2026-10-20T10:00:00.000Z","endAt":"2026-10-20T12:00:00.000Z","purpose":"p"}' `
  409 'Equipment is already booked during this time'

$btBody = Invoke-Api 'Boundary: back-to-back 11:00 -> 13:00 allowed' POST '/bookings' `
  '{"equipmentId":"eq-1","borrowerName":"X","startAt":"2026-10-20T11:00:00.000Z","endAt":"2026-10-20T13:00:00.000Z","purpose":"p"}' `
  201 '"id":"' -PassThru
$bt = ($btBody | ConvertFrom-Json).id

Invoke-Api 'Different equipment, same hours, no conflict' POST '/bookings' `
  '{"equipmentId":"eq-2","borrowerName":"X","startAt":"2026-10-20T09:00:00.000Z","endAt":"2026-10-20T11:00:00.000Z","purpose":"p"}' `
  201 '"equipmentId":"eq-2"'

# --- Generic input errors --------------------------------------------------

Invoke-Api 'Missing borrowerName' POST '/bookings' `
  '{"equipmentId":"eq-1","startAt":"2026-10-26T09:00:00.000Z","endAt":"2026-10-26T10:00:00.000Z","purpose":"p"}' `
  400 'borrowerName is required'

Invoke-Api 'Malformed JSON body' POST '/bookings' '{oops' `
  400 'Request body must be valid JSON'

Invoke-Api 'Unknown booking id on GET' GET '/bookings/no-such-id' $null 404 'Booking not found'

# --- PART 8: PATCH ---------------------------------------------------------

Invoke-Api 'PATCH with its OWN time range must not self-conflict (AND id != ?)' `
  PATCH "/bookings/$a" `
  '{"borrowerName":"Somchai J.","purpose":"Updated","startAt":"2026-10-20T09:00:00.000Z","endAt":"2026-10-20T11:00:00.000Z"}' `
  200 '"purpose":"Updated"'

Invoke-Api 'PATCH into another booking''s window -> 409' PATCH "/bookings/$a" `
  '{"startAt":"2026-10-20T12:00:00.000Z","endAt":"2026-10-20T14:00:00.000Z"}' `
  409 'Equipment is already booked during this time'

Invoke-Api 'PATCH onto unknown equipment -> 404' PATCH "/bookings/$a" `
  '{"equipmentId":"eq-999"}' `
  404 'Equipment not found'

Invoke-Api 'PATCH with reversed range -> 400' PATCH "/bookings/$a" `
  '{"startAt":"2026-10-20T15:00:00.000Z","endAt":"2026-10-20T14:00:00.000Z"}' `
  400 'startAt must be before endAt'

Invoke-Api 'PATCH with no known field -> 400' PATCH "/bookings/$a" `
  '{}' 400 'Request body must include at least one of'

Invoke-Api 'PATCH unknown booking id -> 404' PATCH '/bookings/no-such-id' `
  '{"purpose":"x"}' 404 'Booking not found'

# --- Quality-gate additions: timezone normalisation, merged ranges ---------

$tzBody = Invoke-Api 'Timestamp with +07:00 offset is stored as UTC' POST '/bookings' `
  '{"equipmentId":"eq-1","borrowerName":"TZ Test","startAt":"2026-10-21T00:00:00+07:00","endAt":"2026-10-21T02:00:00+07:00","purpose":"offset"}' `
  201 '"startAt":"2026-10-20T17:00:00.000Z"' -PassThru
$tz = ($tzBody | ConvertFrom-Json).id

Invoke-Api 'Overlap is detected against the NORMALISED UTC value' POST '/bookings' `
  '{"equipmentId":"eq-1","borrowerName":"TZ2","startAt":"2026-10-20T16:00:00.000Z","endAt":"2026-10-20T18:00:00.000Z","purpose":"tz overlap"}' `
  409 'Equipment is already booked during this time'

Invoke-Api 'Partial PATCH with no time fields keeps stored times' PATCH "/bookings/$a" `
  '{"purpose":"Renamed only"}' `
  200 '"startAt":"2026-10-20T09:00:00.000Z"'

Invoke-Api 'PATCH endAt only: merged range conflicts -> 409' PATCH "/bookings/$a" `
  '{"endAt":"2026-10-20T12:30:00.000Z"}' `
  409 'Equipment is already booked during this time'

Invoke-Api 'JSON array body -> 400' POST '/bookings' '[]' `
  400 'Request body must be a JSON object'

# --- PART 9: DELETE --------------------------------------------------------

Invoke-Api 'PART 9: delete a booking -> 204, no body' DELETE "/bookings/$a" $null 204 $null -ExpectEmpty

Invoke-Api 'Booking is gone after delete -> 404' GET "/bookings/$a" $null 404 'Booking not found'

Invoke-Api 'Delete the same id again -> 404' DELETE "/bookings/$a" $null 404 'Booking not found'

Invoke-Api 'Back-to-back neighbour survived the delete' GET "/bookings/$bt" $null 200 '"id":'

# --- Summary ---------------------------------------------------------------

Write-Output '------------------------------------------------'
Write-Output "$($script:case - $script:fails)/$($script:case) cases passed"
if ($script:fails -gt 0) { exit 1 }
