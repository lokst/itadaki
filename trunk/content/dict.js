"use strict";

let EXPORTED_SYMBOLS = ["DictionarySearcher"];

Components.utils["import"]('resource://gre/modules/AddonManager.jsm');
Components.utils["import"]('resource://gre/modules/Services.jsm');

Components.utils["import"]("resource://furiganainserter/utilities.js");

let Ci = Components.interfaces;
let Cc = Components.classes;

function Dictionary (file) {
    this.name = "";
    this.isName = false;
    this.file = file;
    this.isKanji = false;
    this.hasType = false;
    this.hasIndex = false;
}

Dictionary.prototype.findWord = function (word) {
    let db = Services.storage.openDatabase(this.file);
    let entries = [];
    try {
        entries = this.getEntries(db, word);
    } finally {
        db.close();
    }
    return entries;
};

Dictionary.prototype.getEntries = function (db, word) {
    let result = [];
    let st = db.createStatement("SELECT * FROM dict WHERE kanji=:kanji OR kana=:kana");
    try {
        st.params.kanji = word;
        st.params.kana = word;
        while (st.step()) {
            let entry = new Entry();
            entry.kana = st.row.kana;
            entry.kanji = st.row.kanji;
            entry.entry = st.row.entry;
            result.push(entry);
        }
    } finally {
        st.finalize();
    }
    return result;
};

function Entry () {
    this.kanji = "";
    this.kana = "";
    this.entry = "";
    this.reason = "";
}

function SearchResult () {
    this.entries = [];
    this.matchLen = 0;
    this.more = false;
    this.names = false;
    this.title = "";
    this.kanji = false;
}

function Variant (word) {
    this.word = word;
    this.type = 0xFF;
    this.reason = "";
}

function DictionarySearcher () {
    this.deinflector = getDeinflector();
    this.dictionaries = [];
    this.kanjiDictionaries = [];
}

DictionarySearcher.prototype.init = function (rcxDicList) {
    let ids = [];
    let that = this;
    for (let id in rcxDicList) {
        if (rcxDicList.hasOwnProperty(id)) {
            ids.push(id);
        }
    }

    AddonManager.getAddonsByIDs(ids, function (addons) {
        that.dictionaries = [];
        for (let i = 0; i < addons.length; ++i) {
            let addon = addons[i];
            let uri = addon.getResourceURI("dict.sqlite");
            let file = uri.QueryInterface(Ci.nsIFileURL).file;
            let dic = new Dictionary(file);
            let rcxDic = rcxDicList[addon.id];
            dic.isName = rcxDic.isName;
            dic.isKanji = rcxDic.isKanji;
            dic.hasType = rcxDic.hasType;
            dic.name = rcxDic.name;
            if (dic.isKanji) {
                that.kanjiDictionaries.push(dic);
            } else {
                that.dictionaries.push(dic);
            }
        }
    });
};

DictionarySearcher.prototype._wordSearch = function (word, dic) {
    let origWord = word;
    let result = new SearchResult();
    result.title = dic.name;
    result.names = dic.isName;
    word = katakanaToHiragana(word);

    while (word.length > 0) {
        let variants;
        if (dic.isName) {
            variants = [new Variant(word)];
        } else {
            variants = this.deinflector.deinflect(word);
        }
        for (let i = 0; i < variants.length; ++i) {
            let variant = variants[i];
            let entries = dic.findWord(variant.word);
            for (let j = 0; j < entries.length; ++j) {
                let entry = entries[j];
                // > 0 a de-inflected word
                if (dic.hasType && this.checkType(variant.type, entry.entry)
                    || !dic.hasType) {
                    if (result.matchLen === 0) result.matchLen = word.length;
                    if (variant.reason === '') {
                        entry.reason = '';
                    } else if (origWord === word) {
                        entry.reason = '< ' + variant.reason;
                    } else {
                        entry.reason = '< ' + variant.reason + ' < ' + word;
                    }
                    result.entries.push(entry);
                }
            } // for j < entries.length
        } // for i < variants.length
        if (result.entries.length > 0) {
            return result;
        }
        word = word.substr(0, word.length - 1);
    } // while (word.length > 0)
    if (result.entries.length === 0) {
        return null;
    } else {
        return result;
    }
};

DictionarySearcher.prototype.wordSearch = function (word) {
    let retval = [];
    for (let i = 0; i < this.dictionaries.length; ++i) {
        let dic = this.dictionaries[i];
        let e = this._wordSearch(word, dic);
        if (e) {
            retval.push(e);
        }
    }
    retval.sort(function (a, b) {
        return (b.matchLen - a.matchLen);
    });
    return retval;
};

DictionarySearcher.prototype.checkType = function (type, entry) {
    if (type === 0xFF) return true;

    // ex:
    // /(io) (v5r) to finish/to close/
    // /(v5r) to finish/to close/(P)/
    // /(aux-v,v1) to begin to/(P)/
    // /(adj-na,exp,int) thank you/many thanks/
    // /(adj-i) shrill/
    let entryParts = entry.split(/[,()]/);
    for (let i = Math.min(entryParts.length - 1, 10); i >= 0; --i) {
        let entryPart = entryParts[i];
        if ((type & 1) && (entryPart === 'v1')) return true;
        if ((type & 4) && (entryPart === 'adj-i')) return true;
        if ((type & 2) && (entryPart.substr(0, 2) === 'v5')) return true;
        if ((type & 16) && (entryPart.substr(0, 3) === 'vs-')) return true;
        if ((type & 8) && (entryPart === 'vk')) return true;
    }
    return false;
};

DictionarySearcher.prototype.makeHtml = function (searchResult) {
    let result = "<div class='w-title'>" + escapeHTML(searchResult.title) + "</div>";
    let groupedEntries = groupBy(searchResult.entries, (entry) => entry.entry);
    result += groupedEntries.map(function (group) {
        let result = [];
        group.forEach(function (entry) {
            if (entry.kanji !== "" && entry.kanji !== null) {
                result.push("<span class='w-kanji'>", escapeHTML(entry.kanji), "</span>");
            }
            result.push("<span class='w-kana'>", escapeHTML(entry.kana), "</span>");
            if (entry.reason !== "") {
                result.push("<span class='w-conj'>", escapeHTML(entry.reason), "</span>");
            }
            result.push("<br>");
        });
        result.push("<span class='w-def'>",
            escapeHTML(group[0].entry).replace(/\n/g, "<br>").replace(/\//g, "; "),
            "</span>");
        return result.join("");
    }).join("<br>");
    return result;
};

DictionarySearcher.prototype.kanjiSearch = function (c) {
    let searchResult = new SearchResult();
    for (let i = 0; i < this.kanjiDictionaries.length; ++i) {
        let dic = this.kanjiDictionaries[i];
        searchResult.entries = dic.findWord(c);
        searchResult.kanji = true;
        searchResult.title = dic.name;
        break; // only one kanji dictionary allowed
    }
    return searchResult;
};

DictionarySearcher.prototype.moveToTop = function (index) {
    if (index === 0) {
        return;
    }
    let removed = this.dictionaries.splice(index, 1);
    this.dictionaries.unshift(removed[0]);
};

function Rule () {
    this.from = "";
    this.to = "";
    this.type = 0;
    this.reason = 0;
}

let getDeinflector = (function () {
    let deinflector = null;
    return function () {
        if (deinflector) {
            return deinflector;
        }
        deinflector = new Deinflector();
        return deinflector;
    };
})();

function Deinflector () {
    this.reasons = [];
    this.rules = [];
    let string = readUri("chrome://furiganainserter/content/deinflect.dat", "UTF-8");
    let lines = string.split("\r\n");
    for (let i = 1; i < lines.length; ++i) {
        let line = lines[i];
        let fields = line.split("\t");
        if (fields.length === 1) {
            this.reasons.push(fields[0]);
        } else {
            let rule = new Rule();
            rule.from = fields[0];
            rule.to = fields[1];
            rule.type = parseInt(fields[2]);
            rule.reason = parseInt(fields[3]);
            this.rules.push(rule);
        }
    }
}

Deinflector.prototype.deinflect = function (word) {
    let variant = new Variant(word);
    let cache = {};
    cache[word] = variant;
    let variants = [variant];
    let rules = this.rules;
    for (let i = 0; i < variants.length; ++i) {
        let variant = variants[i];
        for (let j = 0; j < rules.length; ++j) {
            let rule = rules[j];
            if (rule.from.length >= variant.word.length) {
                continue;
            }
            let index = variant.word.length - rule.from.length;
            let end = variant.word.substring(index);
            if ((variant.type & rule.type) === 0 || end !== rule.from) {
                continue;
            }
            let newWord = variant.word.substring(0, index) + rule.to;
            // update cache
            if (cache.hasOwnProperty(newWord)) {
                newVariant = cache[newWord];
                newVariant.type |= (rule.type >> 8);
            }
            //new deinflection
            else {
                let newVariant = new Variant(newWord);
                newVariant.type = rule.type >> 8;
                if (variant.reason === "") {
                    newVariant.reason = this.reasons[rule.reason];
                } else {
                    newVariant.reason = this.reasons[rule.reason] + ' < '
                    + variant.reason;
                }
                cache[newWord] = newVariant;
                variants.push(newVariant);
            }
        }
    }
    return variants;
};
