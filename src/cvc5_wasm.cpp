/*
 * cvc5-wasm: a thin C wrapper that turns cvc5 into a library callable from
 * JavaScript.  One call runs one whole SMT-LIB 2.6 script and returns what the
 * script's commands print, exactly as the cvc5 binary would print it on stdout.
 *
 * Two designs for the state between calls are implemented; see README.md.
 *   default                          fresh TermManager/Solver/SymbolManager per call
 *   -DCVC5_WASM_PERSISTENT_SOLVER    one session, SMT-LIB (reset) between calls
 */
#include <cvc5/cvc5.h>
#include <cvc5/cvc5_parser.h>

#include <exception>
#include <sstream>
#include <string>

using namespace cvc5;
using namespace cvc5::parser;

namespace {

/** Owns the string the last call handed back to JavaScript. */
std::string g_result;

/** Same escaping cvc5 uses for `(error "...")`: double every quote. */
std::string quoteMessage(const std::string& message)
{
  std::string s = message;
  for (size_t i = s.find('"'); i != std::string::npos; i = s.find('"', i + 2))
  {
    s.replace(i, 1, "\"\"");
  }
  return '"' + s + '"';
}

/** Parse and invoke every command in `script`, printing results to `out`. */
void invokeAll(Solver* slv,
               SymbolManager* sm,
               const std::string& script,
               std::ostream& out)
{
  InputParser parser(slv, sm);
  parser.setStringInput(modes::InputLanguage::SMT_LIB_2_6, script, "query");
  for (;;)
  {
    Command cmd = parser.nextCommand();
    if (cmd.isNull())
    {
      break;
    }
    cmd.invoke(slv, sm, out);
  }
}

#ifdef CVC5_WASM_PERSISTENT_SOLVER

/** Design 2: one solver for the session, reset after each script. */
struct Session
{
  Session() : d_tm(), d_slv(d_tm), d_sm(d_tm) {}
  TermManager d_tm;
  Solver d_slv;
  SymbolManager d_sm;
};

Session* g_session = nullptr;

void discardSession()
{
  delete g_session;
  g_session = nullptr;
}

void runScript(const std::string& script, std::ostream& out)
{
  if (g_session == nullptr)
  {
    g_session = new Session();
  }
  try
  {
    invokeAll(&g_session->d_slv, &g_session->d_sm, script, out);
  }
  catch (...)
  {
    // Reset before letting the failure out, so the next call starts clean.
    try
    {
      std::ostringstream sink;
      invokeAll(&g_session->d_slv, &g_session->d_sm, "(reset)", sink);
    }
    catch (...)
    {
      discardSession();
    }
    throw;
  }
  try
  {
    std::ostringstream sink;
    invokeAll(&g_session->d_slv, &g_session->d_sm, "(reset)", sink);
  }
  catch (...)
  {
    discardSession();
  }
}

#else

/** Design 1: fresh solver per script; isolation is automatic. */
void runScript(const std::string& script, std::ostream& out)
{
  TermManager tm;
  Solver slv(tm);
  SymbolManager sm(tm);
  invokeAll(&slv, &sm, script, out);
}

void discardSession() {}

#endif

}  // namespace

extern "C" {

const char* cvc5_solve(const char* script)
{
  std::ostringstream out;
  try
  {
    runScript(script == nullptr ? std::string() : std::string(script), out);
  }
  catch (const std::exception& e)
  {
    out << "(error " << quoteMessage(e.what()) << ')' << std::endl;
  }
  catch (...)
  {
    out << "(error \"unrecognized exception\")" << std::endl;
  }
  g_result = out.str();
  return g_result.c_str();
}

void cvc5_reset(void)
{
  discardSession();
  g_result.clear();
  g_result.shrink_to_fit();
}

const char* cvc5_version(void)
{
  // Solver::getVersion() returns by value; keep a copy alive for the caller.
  static const std::string version = [] {
    TermManager tm;
    Solver slv(tm);
    return slv.getVersion();
  }();
  return version.c_str();
}

}  // extern "C"
