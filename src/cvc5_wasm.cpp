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

/**
 * Design 2: one TermManager for the session, so its caches stay warm, with a
 * fresh Solver and SymbolManager per call.  That is what SMT-LIB `(reset)`
 * does -- cvc5's own ResetCommand destroys the solver and reconstructs it on
 * the same term manager with its original options -- except that the symbol
 * manager is replaced rather than reset, because SymManager::reset() keeps its
 * logic flag set, which makes the next script's (set-logic ...) fail.
 */
TermManager* g_tm = nullptr;

void discardSession()
{
  delete g_tm;
  g_tm = nullptr;
}

void runScript(const std::string& script, std::ostream& out)
{
  if (g_tm == nullptr)
  {
    g_tm = new TermManager();
  }
  Solver slv(*g_tm);
  SymbolManager sm(*g_tm);
  invokeAll(&slv, &sm, script, out);
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
