var traceur = require('traceur');

function traceurGet(module) {
  return $traceurRuntime.ModuleStore.get('traceur@0.0.95/src/' + module);
};

var ParseTreeTransformer = traceurGet('codegeneration/ParseTreeTransformer.js').ParseTreeTransformer;
var ScopeTransformer = traceurGet('codegeneration/ScopeTransformer.js').ScopeTransformer;


var Script = traceurGet('syntax/trees/ParseTrees.js').Script;
var parseStatements = traceurGet('codegeneration/PlaceholderParser.js').parseStatements;
var STRING = traceurGet('syntax/TokenType.js').STRING;
var LiteralExpression = traceurGet('syntax/trees/ParseTrees.js').LiteralExpression;
var LiteralToken = traceurGet('syntax/LiteralToken.js').LiteralToken;

// format detection regexes
var leadingCommentAndMetaRegEx = /^\s*(\/\*[^\*]*(\*(?!\/)[^\*]*)*\*\/|\s*\/\/[^\n]*|\s*"[^"]+"\s*;?|\s*'[^']+'\s*;?)*\s*/;
var cjsRequireRegEx = /(?:^\uFEFF?|[^$_a-zA-Z\xA0-\uFFFF."'])require\s*\(\s*("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')\s*\)/g;
var cjsExportsRegEx = /(?:^\uFEFF?|[^$_a-zA-Z\xA0-\uFFFF.])(exports\s*(\[['"]|\.)|module(\.exports|\['exports'\]|\["exports"\])\s*(\[['"]|[=,\.]))/;
var amdRegEx = /(?:^\uFEFF?|[^$_a-zA-Z\xA0-\uFFFF.])define\s*\(\s*("[^"]+"\s*,\s*|'[^']+'\s*,\s*)?\s*(\[(\s*(("[^"]+"|'[^']+')\s*,|\/\/.*\r?\n|\/\*(.|\s)*?\*\/))*(\s*("[^"]+"|'[^']+')\s*,?)?(\s*(\/\/.*\r?\n|\/\*(.|\s)*?\*\/))*\s*\]|function\s*|{|[_$a-zA-Z\xA0-\uFFFF][_$a-zA-Z0-9\xA0-\uFFFF]*\))/;

var metaRegEx = /^(\s*\/\*[^\*]*(\*(?!\/)[^\*]*)*\*\/|\s*\/\/[^\n]*|\s*"[^"]+"\s*;?|\s*'[^']+'\s*;?)+/;
var metaPartRegEx = /\/\*[^\*]*(\*(?!\/)[^\*]*)*\*\/|\/\/[^\n]*|"[^"]+"\s*;?|'[^']+'\s*;?/g;

exports.detectFormat = function(source) {
  // read any SystemJS meta syntax
  var meta = source.match(metaRegEx);
  if (meta) {
    var metaParts = meta[0].match(metaPartRegEx);

    for (var i = 0; i < metaParts.length; i++) {
      var curPart = metaParts[i];
      var len = curPart.length;

      var firstChar = curPart.substr(0, 1);
      if (curPart.substr(len - 1, 1) == ';')
        len--;

      if (firstChar != '"' && firstChar != "'")
        continue;

      var metaString = curPart.substr(1, curPart.length - 3);

      if (metaString.substr(0, 7) == 'format ')
        return metaString.substr(7);
      else if (metaString == 'bundle')
        return 'register';
    }
  }

  // detect register    
  var leadingCommentAndMeta = source.match(leadingCommentAndMetaRegEx);
  if (leadingCommentAndMeta && source.substr(leadingCommentAndMeta[0].length, 15) == 'System.register')
    return 'register';

  // esm
  try {
    var compiler = new traceur.Compiler({ script: false });
    var tree = compiler.parse(source);
    var transformer = new ESMDetectionTransformer();
    transformer.transformAny(tree);
    if (transformer.isESModule)
      return 'esm';
    else
      compiler = tree = undefined;
  }
  catch(e) {
    compiler = tree = undefined;
  }

  // cjs
  // (NB this should be updated to be parser based, with caching by name to parseCJS below)
  if (source.match(cjsRequireRegEx) || source.match(cjsExportsRegEx))
    return 'cjs';

  // amd
  if (source.match(amdRegEx))
    return 'amd';

  // fallback is cjs (not global)
  return 'cjs';
};

exports.parseCJS = function(source) {
  var output = {
    requires: [],
    usesBuffer: false
  };

  var compiler, tree, transformer;

  // CJS Buffer detection and require extraction
  try {
    compiler = new traceur.Compiler({ script: true });
    tree = tree || compiler.parse(source);
  }
  catch(e) {
    return output;
  }

  // sets output.requires
  transformer = new CJSDepsTransformer();
  try {
    transformer.transformAny(tree);
  }
  catch(e) {}
  output.requires = transformer.requires;

  // sets output.usesBuffer
  transformer = new GlobalUsageTransformer('Buffer');
  try {
    transformer.transformAny(tree);
  }
  catch(e) {}
  output.usesBuffer = !!transformer.usesGlobal;

  return output;
};


function ESMDetectionTransformer() {
  this.isESModule = false;
  return ParseTreeTransformer.apply(this, arguments);
}
ESMDetectionTransformer.prototype = Object.create(ParseTreeTransformer.prototype);
ESMDetectionTransformer.prototype.transformExportDeclaration = function(tree) {
  this.isESModule = true;
  return ParseTreeTransformer.prototype.transformExportDeclaration.call(this, tree);
};
ESMDetectionTransformer.prototype.transformImportDeclaration = function(tree) {
  this.isESModule = true;
  return ParseTreeTransformer.prototype.transformImportDeclaration.call(this, tree);
};

// esm remapping not currently in use
/*
function ESMImportsTransformer() {
  this.imports = [];
  return ParseTreeTransformer.apply(this, arguments);
}
ESMImportsTransformer.prototype = Object.create(ParseTreeTransformer.prototype);
ESMImportsTransformer.prototype.transformModuleSpecifier = function(tree) {
  if (this.imports.indexOf(tree.token.processedValue) == -1)
    this.imports.push(tree.token.processedValue);

  return ParseTreeTransformer.prototype.transformModuleSpecifier.call(this, tree);
};
*/

function CJSDepsTransformer() {
  this.requires = [];
  return ParseTreeTransformer.apply(this, arguments);
}
CJSDepsTransformer.prototype = Object.create(ParseTreeTransformer.prototype);

CJSDepsTransformer.prototype.transformCallExpression = function(tree) {
  if (!tree.operand.identifierToken || tree.operand.identifierToken.value != 'require')
    return ParseTreeTransformer.prototype.transformCallExpression.call(this, tree);

  // found a require
  var args = tree.args.args;
  if (args.length && args[0].type == 'LITERAL_EXPRESSION' && args.length == 1) {
    if (this.requires.indexOf(args[0].literalToken.processedValue) == -1)
      this.requires.push(args[0].literalToken.processedValue);
  }

  return ParseTreeTransformer.prototype.transformCallExpression.call(this, tree);
};

function GlobalUsageTransformer(varName) {
  this.usesGlobal = undefined;
  return ScopeTransformer.apply(this, arguments);
}
GlobalUsageTransformer.prototype = Object.create(ScopeTransformer.prototype);
GlobalUsageTransformer.prototype.transformIdentifierExpression = function(tree) {
  if (tree.identifierToken.value == this.varName_ && this.usesGlobal !== false)
    this.usesGlobal = true;
  return ScopeTransformer.prototype.transformIdentifierExpression.apply(this, arguments);
};
GlobalUsageTransformer.prototype.transformBindingIdentifier = function(tree) {
  if (tree.identifierToken.value == this.varName_ && this.usesGlobal !== false)
    this.usesGlobal = true;
  return ScopeTransformer.prototype.transformBindingIdentifier.apply(this, arguments);
};
GlobalUsageTransformer.prototype.sameTreeIfNameInLoopInitializer_ = function(tree) {
  try {
    tree = ScopeTransformer.prototype.sameTreeIfNameInLoopInitializer_.call(this, tree);
  }
  catch(e) {}
  return tree;
};

// NB incorrect handling for function Buffer() {}, but we don't have better scope analysis available
// until a shift to Babel :(
GlobalUsageTransformer.prototype.transformFunctionDeclaration = function(tree) {
  if (tree.name && tree.name.identifierToken && tree.name.identifierToken.value == this.varName_)
    this.usesGlobal = false;
  return ScopeTransformer.prototype.transformFunctionDeclaration.apply(this, arguments);
}
GlobalUsageTransformer.prototype.getDoNotRecurse = function(tree) {
  var doNotRecurse;
  try {
    doNotRecurse = ScopeTransformer.prototype.getDoNotRecurse.call(this, tree);
  }
  catch(e) {}
  return doNotRecurse;
};
GlobalUsageTransformer.prototype.transformBlock = function(tree) {
  try {
    tree = ScopeTransformer.prototype.transformBlock.call(this, tree);
  }
  catch(e) {}
  return tree;
};