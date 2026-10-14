/*
 * Seal fork-CI driver: runs the jQuery QUnit suite (test/index.html) in
 * headless Chrome via puppeteer-core and reports the results on stdout.
 *
 * Like upstream's own CI (Gruntfile `testswarm.tests` + build/tasks/testswarm.js,
 * which loads test/index.html?module=<name> once per module), every module runs
 * in its own fresh page, so tests that leak fixtures outside #qunit-fixture
 * (e.g. basic: offset) cannot break later modules. `?dev` makes test/jquery.js
 * load the un-minified dist/jquery.js.
 *
 * Usage: node test/seal-browser-runner.js [base-url]
 *   base-url          default http://127.0.0.1:8000/test/index.html
 *   CHROME_PATH       Chrome/Chromium executable (required)
 *   SEAL_MODULES      optional comma/space-separated module list; default is
 *                     Gruntfile.js `testswarm.tests` plus ready and wrap
 *   SEAL_TEST_FILTER  optional QUnit `filter` (substring of "module: test")
 *   SEAL_SKIP_TESTS   optional newline- or "||"-separated list of exact
 *                     "module: test name" entries that are not registered
 *                     (printed as SKIPPED); test/unit files stay pristine
 *
 * Exit: 0 all green, 1 failures (or a module ran zero tests), 2 timeout /
 * suite never finished / browser error.
 */
/* global process: false, require: false, Promise: false, __dirname: false */
( function() {
"use strict";

var fs = require( "fs" ),
	path = require( "path" ),
	puppeteer = require( "puppeteer-core" );

var OVERALL_TIMEOUT_MS = 25 * 60 * 1000,
	MODULE_TIMEOUT_MS = 10 * 60 * 1000,
	HEARTBEAT_MS = 120 * 1000,
	PREFIX = "__SEAL__",

	// Loaded by test/data/testinit.js but absent from the testswarm list
	EXTRA_MODULES = [ "ready", "wrap" ],
	baseUrl = process.argv[ 2 ] || "http://127.0.0.1:8000/test/index.html",
	filter = process.env.SEAL_TEST_FILTER || "",
	skipList = splitList( process.env.SEAL_SKIP_TESTS || "", /\|\||\n/ ),
	moduleList = process.env.SEAL_MODULES ?
		splitList( process.env.SEAL_MODULES, /[\s,]+/ ) :
		gruntfileModules().concat( EXTRA_MODULES );

function splitList( str, sep ) {
	return str.split( sep ).map( function( s ) {
		return s.replace( /^\s+|\s+$/g, "" );
	} ).filter( function( s ) {
		return s.length > 0;
	} );
}

// Read the per-module run list from Gruntfile.js `testswarm: { tests: [ ... ] }`
function gruntfileModules() {
	var text = fs.readFileSync( path.join( __dirname, "..", "Gruntfile.js" ), "utf8" ),
		match = /testswarm\s*:\s*\{\s*tests\s*:\s*\[([^\]]*)\]/.exec( text ),
		names = [],
		re = /"([^"]+)"/g,
		m;
	if ( !match ) {
		console.error( "Could not find testswarm.tests in Gruntfile.js" );
		process.exit( 2 );
	}
	while ( ( m = re.exec( match[ 1 ] ) ) ) {
		names.push( m[ 1 ] );
	}
	return names;
}

if ( !process.env.CHROME_PATH ) {
	console.error( "CHROME_PATH is not set" );
	process.exit( 2 );
}
if ( !moduleList.length ) {
	console.error( "No modules to run" );
	process.exit( 2 );
}

function moduleUrl( name ) {
	return baseUrl + ( baseUrl.indexOf( "?" ) >= 0 ? "&" : "?" ) + "dev&module=" +
		encodeURIComponent( name ) +
		( filter ? "&filter=" + encodeURIComponent( filter ) : "" );
}

/*
 * Runs in every frame before any page script. Only the top frame is hooked:
 * the suite spawns many iframes that load QUnit themselves.
 */
function pageHook( skipNames ) {

	// Snapshot natives up front: the ajax "getJSON() - Using Native JSON" test
	// replaces window.JSON with a parse-only stub, and a reporter calling
	// JSON.stringify while it is installed would throw and wedge the suite.
	var nativeJSON = window.JSON,
		nativeStringify = nativeJSON.stringify,
		nativeConsole = window.console,
		nativeLog = nativeConsole.log,
		skip = {},
		hooked = false,
		qunitRef, i;

	if ( window.top !== window ) {
		return;
	}

	for ( i = 0; i < skipNames.length; i++ ) {
		skip[ skipNames[ i ] ] = true;
	}

	function emit( type, data ) {
		try {
			nativeLog.call( nativeConsole, "__SEAL__" +
				nativeStringify.call( nativeJSON, { type: type, data: data } ) );
		} catch ( e ) {
			try {
				nativeLog.call( nativeConsole, "__SEAL__" + nativeStringify.call( nativeJSON, {
					type: type, data: { error: "unserializable payload: " + e }
				} ) );
			} catch ( e2 ) {}
		}
	}

	function dump( value ) {
		var out;
		try {
			if ( qunitRef && qunitRef.dump ) {
				out = qunitRef.dump.parse( value );
			} else {
				out = String( value );
			}
		} catch ( e ) {
			try {
				out = String( value );
			} catch ( e2 ) {
				out = "<undumpable>";
			}
		}
		if ( typeof out === "string" && out.length > 2000 ) {
			out = out.slice( 0, 2000 ) + "...";
		}
		return out;
	}

	function safe( fn ) {
		return function( d ) {
			try {
				fn( d || {} );
			} catch ( e ) {}
		};
	}

	function hookQUnit( q ) {
		var origTest, wrappedTest;

		if ( hooked || !q || !q.config ) {
			return;
		}
		hooked = true;

		q.config.reorder = false;

		// Skip support: every registration path ends in QUnit.test or the
		// window.test global captured before we got here (asyncTest,
		// testIframe, ajaxTest all call QUnit.test), where the effective
		// module/name is known (QUnit 1.17: config.currentModule is an object).
		origTest = q.test;
		wrappedTest = function( testName ) {
			var mod = q.config.currentModule,
				modName = mod && typeof mod === "object" ? mod.name : mod,
				key = ( modName ? modName + ": " : "" ) + testName,
				urlModule;
			if ( skip[ key ] ) {

				// Every page loads all test files; only report the skip on the
				// page whose ?module= would have run it.
				urlModule = q.urlParams && q.urlParams.module;
				if ( !urlModule || String( urlModule ).toLowerCase() ===
						String( modName ).toLowerCase() ) {
					emit( "skip", { name: key } );
				}
				return;
			}
			return origTest.apply( this, arguments );
		};
		q.test = wrappedTest;
		window.test = wrappedTest;

		q.begin( safe( function() {
			emit( "begin", {} );
		} ) );
		q.moduleStart( safe( function( d ) {
			emit( "moduleStart", { name: d.name } );
		} ) );
		q.testStart( safe( function( d ) {
			emit( "testStart", { name: d.name, module: d.module } );
		} ) );
		q.log( safe( function( d ) {
			if ( d.result ) {
				return;
			}
			emit( "log", {
				module: d.module,
				name: d.name,
				message: d.message === undefined ? "" : String( d.message ),
				actual: dump( d.actual ),
				expected: dump( d.expected ),
				source: d.source === undefined ? "" : String( d.source )
			} );
		} ) );
		q.testDone( safe( function( d ) {
			emit( "testDone", {
				name: d.name,
				module: d.module,
				failed: d.failed,
				passed: d.passed,
				total: d.total
			} );
		} ) );
		q.done( safe( function( d ) {
			emit( "done", {
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} );
		} ) );
	}

	// qunit.js assigns window.QUnit once, fully built (config + logging
	// callbacks); trap that assignment so the hooks precede any test file.
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunitRef;
		},
		set: function( v ) {
			qunitRef = v;
			hookQUnit( v );
		}
	} );
}

function pad( s, n ) {
	s = String( s );
	while ( s.length < n ) {
		s += " ";
	}
	return s;
}

function main() {
	var browser, heartbeatTimer, overallTimer,
		finished = false,
		modules = {},
		moduleOrder = [],
		moduleRuns = [],
		failedTests = 0,
		passedTests = 0,
		skippedTests = [],
		currentModuleRun = null,
		currentTest = null,
		lastProgress = Date.now(),
		lastHeartbeat = Date.now();

	function moduleStats( name ) {
		if ( !modules[ name ] ) {
			modules[ name ] = { tests: 0, failedTests: 0, assertions: 0, failedAssertions: 0 };
			moduleOrder.push( name );
		}
		return modules[ name ];
	}

	function printSummary() {
		var totalTests = passedTests + failedTests,
			totalAssertions = 0,
			failedAssertions = 0;
		console.log( "" );
		console.log( "==================== SUMMARY ====================" );
		if ( skippedTests.length ) {
			console.log( "Skipped (not registered): " + skippedTests.length );
			skippedTests.forEach( function( n ) {
				console.log( "  SKIPPED: " + n );
			} );
		}
		skipList.forEach( function( n ) {
			if ( skippedTests.indexOf( n ) < 0 ) {
				console.log( "  WARNING: SEAL_SKIP_TESTS entry matched no test: " + n );
			}
		} );
		moduleRuns.forEach( function( r ) {
			console.log( "page ?module=" + r.name + ": " + ( r.done ?
				"QUnit done, " + r.done.passed + "/" + r.done.total + " assertions passed, " +
					r.done.runtime + " ms" :
				"QUnit done NEVER fired" ) );
		} );
		console.log( pad( "module", 20 ) + pad( "tests", 8 ) + pad( "failed", 8 ) +
			pad( "assertions", 12 ) + "failed" );
		moduleOrder.forEach( function( name ) {
			var m = modules[ name ];
			totalAssertions += m.assertions;
			failedAssertions += m.failedAssertions;
			console.log( pad( name, 20 ) + pad( m.tests, 8 ) + pad( m.failedTests, 8 ) +
				pad( m.assertions, 12 ) + m.failedAssertions );
		} );
		console.log( "SEAL QUnit summary: " + totalTests + " tests, " + passedTests +
			" passed, " + failedTests + " failed, " + totalAssertions + " assertions (" +
			failedAssertions + " failed)" +
			( skippedTests.length ? ", " + skippedTests.length + " skipped" : "" ) +
			"; " + moduleRuns.length + "/" + moduleList.length + " module pages run" );
	}

	function finish( code, reason ) {
		var closing;
		if ( finished ) {
			return;
		}
		finished = true;
		clearInterval( heartbeatTimer );
		clearTimeout( overallTimer );
		if ( reason ) {
			console.log( reason );
		}
		printSummary();

		// Do not let a hung browser.close() keep us alive.
		setTimeout( function() {
			process.exit( code );
		}, 15000 ).unref();
		closing = browser ? browser.close() : Promise.resolve();
		closing.then( null, function() {} ).then( function() {
			process.exit( code );
		} );
	}

	function onEvent( run, ev ) {
		var m,
			d = ev.data || {};
		if ( run !== currentModuleRun ) {
			return;
		}
		switch ( ev.type ) {
		case "begin":
			console.log( "QUnit begin (?module=" + run.name + ")" );
			break;
		case "moduleStart":
			console.log( "MODULE " + d.name );
			break;
		case "testStart":
			currentTest = ( d.module ? d.module + ": " : "" ) + d.name;
			break;
		case "log":
			console.log( "    assertion failed: " + d.message );
			console.log( "      expected: " + d.expected );
			console.log( "      actual:   " + d.actual );
			if ( d.source ) {
				console.log( "      source:   " +
					String( d.source ).split( "\n" ).join( "\n                " ) );
			}
			break;
		case "testDone":
			lastProgress = Date.now();
			lastHeartbeat = lastProgress;
			currentTest = null;
			run.tests++;
			m = moduleStats( d.module || "(no module)" );
			m.tests++;
			m.assertions += d.total;
			m.failedAssertions += d.failed;
			if ( d.failed > 0 ) {
				m.failedTests++;
				failedTests++;
			} else {
				passedTests++;
			}
			console.log( ( d.failed > 0 ? "FAIL" : "PASS" ) + " [" + d.module + "] " + d.name +
				" (" + d.passed + "/" + d.total + ")" );
			break;
		case "skip":
			skippedTests.push( d.name );
			console.log( "SKIPPED: " + d.name );
			break;
		case "done":
			run.done = d;
			run.resolve();
			break;
		default:
			console.log( "unknown event: " + JSON.stringify( ev ) );
		}
	}

	function runModule( name ) {
		var page, moduleTimer,
			run = { name: name, tests: 0, done: null };
		moduleRuns.push( run );
		currentModuleRun = run;
		console.log( "" );
		console.log( "=== PAGE " + moduleUrl( name ) );

		return new Promise( function( resolve, reject ) {
			run.resolve = resolve;
			moduleTimer = setTimeout( function() {
				reject( new Error( "module " + name + " did not finish within " +
					( MODULE_TIMEOUT_MS / 60000 ) + " minutes" +
					( currentTest ? " (running: " + currentTest + ")" : "" ) ) );
			}, MODULE_TIMEOUT_MS );

			browser.newPage().then( function( p ) {
				page = p;
				page.on( "console", function( msg ) {
					var ev,
						text = msg.text();
					if ( text.indexOf( PREFIX ) !== 0 ) {
						return;
					}
					try {
						ev = JSON.parse( text.slice( PREFIX.length ) );
					} catch ( e ) {
						console.log( "unparseable reporter line: " + text.slice( 0, 500 ) );
						return;
					}
					onEvent( run, ev );
				} );
				page.on( "pageerror", function( err ) {
					console.log( "PAGE ERROR: " +
						( err && err.message ? err.message : String( err ) ) );
				} );
				page.on( "dialog", function( dialog ) {
					console.log( "DIALOG (" + dialog.type() + "): " + dialog.message() );
					dialog.dismiss().then( null, function() {} );
				} );
				page.on( "error", function( err ) {
					reject( new Error( "page crashed: " +
						( err && err.message ? err.message : String( err ) ) ) );
				} );
				return page.evaluateOnNewDocument( pageHook, skipList );
			} ).then( function() {
				return page[ "goto" ]( moduleUrl( name ), { waitUntil: "load", timeout: 120000 } );
			} ).then( null, reject );
		} ).then( function() {
			clearTimeout( moduleTimer );
			return page.close().then( null, function() {} );
		}, function( err ) {
			clearTimeout( moduleTimer );
			throw err;
		} ).then( function() {
			if ( run.tests === 0 ) {
				throw new Error( "?module=" + name + " ran zero tests" );
			}
		} );
	}

	overallTimer = setTimeout( function() {
		finish( 2, "TIMEOUT: suite did not finish within " + ( OVERALL_TIMEOUT_MS / 60000 ) +
			" minutes" + ( currentTest ? " (running: " + currentTest + ")" : "" ) );
	}, OVERALL_TIMEOUT_MS );

	heartbeatTimer = setInterval( function() {
		var now = Date.now();
		if ( now - lastHeartbeat >= HEARTBEAT_MS ) {
			lastHeartbeat = now;
			console.log( "HEARTBEAT: no test completed in " +
				Math.round( ( now - lastProgress ) / 1000 ) + "s; running: " +
				( currentTest || "(none / between tests)" ) );
		}
	}, 5000 );

	console.log( "Modules (" + moduleList.length + "): " + moduleList.join( ", " ) );
	if ( skipList.length ) {
		console.log( "SEAL_SKIP_TESTS: " + skipList.length + " test(s)" );
	}

	puppeteer.launch( {
		executablePath: process.env.CHROME_PATH,
		headless: true,
		args: [ "--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1",
			"--window-size=1280,1024" ]
	} ).then( function( b ) {
		browser = b;
		browser.on( "disconnected", function() {
			finish( 2, "ERROR: browser disconnected before the suite finished" );
		} );
		return moduleList.reduce( function( chain, name ) {
			return chain.then( function() {
				return runModule( name );
			} );
		}, Promise.resolve() );
	} ).then( function() {
		finish( failedTests === 0 && passedTests > 0 ? 0 : 1 );
	}, function( err ) {
		finish( 2, "ERROR: " + ( err && err.stack ? err.stack : String( err ) ) );
	} );
}

main();

} )();
