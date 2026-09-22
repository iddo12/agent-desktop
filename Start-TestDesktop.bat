@echo off
REM ===========================================================================
REM  Agent Desktop - SANDBOX / TEST INSTANCE
REM
REM  Runs a second, disposable copy of the app against fixture agents, so
REM  changes can be developed and tested without touching Iddo's live
REM  instance. Deliberately a console window, not the silent Launch.vbs: a
REM  test instance should be obvious while it is running.
REM
REM  It is isolated by three things, not by being a copied folder:
REM    - AGENT_DESKTOP_ROOT    -> fixture agents, never the real workspace
REM    - userData redirected   -> its own logs, UI flags, sent-message history
REM    - the machine-wide process reaper and the background-dispatch sweep
REM      REFUSE to run in test mode (see src/testMode.js for why that matters)
REM
REM  Usage:
REM    Start-TestDesktop.bat          fixtures only, spends nothing  (tiers 1+2)
REM    Start-TestDesktop.bat live     also allows ONE real agent     (tier 3)
REM ===========================================================================

setlocal
cd /d "%~dp0"

set "AGENT_DESKTOP_TEST_MODE=1"
set "AGENT_DESKTOP_ROOT=E:\Claude work\Security\AgentDesktopSandbox\agents"

REM Tier 3 is opt-in per launch and never sticky. The budget is Iddo's
REM condition for allowing a real agent at all: it pauses every sandbox agent
REM once spent, and only he raises it.
if /I "%~1"=="live" (
  set "AGENT_DESKTOP_ALLOW_LIVE_AGENTS=1"
  if "%AGENT_DESKTOP_TEST_TOKEN_BUDGET%"=="" set "AGENT_DESKTOP_TEST_TOKEN_BUDGET=150000"
  echo(
  echo   *** TIER 3: this instance MAY start real Claude agents. ***
  echo   Token budget: %AGENT_DESKTOP_TEST_TOKEN_BUDGET%. Every sandbox agent is
  echo   paused automatically once that is spent.
  echo(
) else (
  echo(
  echo   Tiers 1-2: fixtures only. No Claude process will be started and
  echo   nothing will be spent. Pass "live" to allow a real agent.
  echo(
)

if not exist "%AGENT_DESKTOP_ROOT%" (
  echo   No fixtures found - building them first...
  node tools\make-fixtures.js
  echo(
)

echo   Agent root : %AGENT_DESKTOP_ROOT%
echo   Starting sandbox instance...
echo(

call npx electron .

endlocal
