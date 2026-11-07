"""Readable names for DGFiP legal-entity owners.

The DGFiP file stores names in capitals, without accents, with apostrophes turned into spaces, cut at 60 characters,
and with the legal form (GFA, SCI, SCEA…) in a separate column. display_name() puts them back together:
  - the abbreviated legal form is put in front when the name does not already carry it ("SCI" + "DES ANTES"),
  - words get ordinary capitals; legal forms and other abbreviations stay in capitals; small French linking words
    (de, du, des, la, le, les, et, en, sur, sous, au, aux) are lower case except at the start,
  - "D OR" / "L EGLISE" become "d'Or" / "l'Église",
  - accents come back for a fixed list of common words, and for commune names from the atlas's own list,
  - a name cut at 60 characters is replaced by the full registered name when a SIREN lookup found one (full_names),
    otherwise it ends in "…".
The original DGFiP name is always kept alongside, so nothing is lost if a rule guesses wrong.
"""
from __future__ import annotations
import re, unicodedata

LEGAL_FORMS = {"GFA", "GFV", "GFR", "GFO", "GF", "GFF", "SCI", "SCEA", "SCA", "SC", "SCV", "SAS", "SASU", "SARL", "SA", "EARL", "GAEC", "SNC", "EURL", "SCP", "SICA", "CUMA", "GIE", "SCIC", "SEM", "SPL", "SCM", "SELARL", "SCPI", "OPCI", "SCS", "SCOP"}
ACRONYMS = LEGAL_FORMS | {"SNCF", "APRR", "EDF", "GDF", "SAFER", "OPAC", "OPH", "HLM", "BND", "ASF", "RTE", "ONF", "CCAS", "SIVOM", "SIVU", "SICTOM", "SMICTOM", "VNF", "CEA", "INRA", "INRAE", "CNRS", "SDIS", "RFF", "SIE", "SIAEP", "AFR", "AFP", "ASA", "OGEC", "ADAPEI", "CHU", "CHS", "EHPAD", "ESAT", "SEMAAD", "CDC", "SCIC", "UDAF", "CROUS", "SNCF", "CPAM", "MSA", "CAF", "LPO", "ENEDIS", "GRDF", "AXA", "BNP", "LCL", "II", "III", "IV"}
# Standard DGFiP abbreviations, written out (only where the meaning is unambiguous).
EXPAND = {"SOC": "SOCIETE", "CIV": "CIVILE", "CIVIL": "CIVILE", "IMMOB": "IMMOBILIERE", "SYND": "SYNDICAT", "COPROP": "COPROPRIETE", "GPT": "GROUPEMENT", "GROUPT": "GROUPEMENT",
          "EXPL": "EXPLOITATION", "AGRIC": "AGRICOLE", "VITIC": "VITICOLE", "FONC": "FONCIER", "ASSOC": "ASSOCIATION", "INTERCOM": "INTERCOMMUNAL", "DEVELOP": "DEVELOPPEMENT"}
# Names starting like this already say what they are: no legal form in front.
SELF_DESCRIBED = {"SOCIETE", "STE", "GROUPEMENT", "CAISSE", "BANQUE", "COMPAGNIE", "CIE", "SYNDICAT", "ASSOCIATION", "ASS", "UNION", "FONDATION", "OFFICE", "CENTRE", "INSTITUT", "MUTUELLE", "COOPERATIVE", "CAVE", "COMMUNE", "DEPARTEMENT", "REGION", "ETAT", "HOSPICES", "CENTRE"}
LOWER = {"DE", "DU", "DES", "LA", "LE", "LES", "ET", "EN", "SUR", "SOUS", "AU", "AUX", "A", "PAR", "POUR"}
# Forms that are already part of how the name reads ("COMMUNE DE …", "DEPARTEMENT DE …") or that only mean "other
# legal person": no prefix for those.
NO_PREFIX = {"COM", "DEPT", "ETAT", "AUPM", "COLL", "AUDA", "EPIC", "EPA", "REG", "ASSO", "SYND", "COPRO", "ETS", "CNE"}
ACCENTS = {
    "SOCIETE": "Société", "ETAT": "État", "DEPARTEMENT": "Département", "REGION": "Région", "REGIONALE": "Régionale", "REGIONAL": "Régional",
    "COTE": "Côte", "COTES": "Côtes", "COTEAU": "Coteau", "CHATEAU": "Château", "CHATEAUX": "Châteaux", "HERITIERS": "Héritiers", "HERITIER": "Héritier",
    "FRERES": "Frères", "FRERE": "Frère", "SOEURS": "Sœurs", "PERE": "Père", "MERE": "Mère", "IMMOBILIERE": "Immobilière", "FONCIERE": "Foncière",
    "ELECTRICITE": "Électricité", "ENERGIE": "Énergie", "ENERGIES": "Énergies", "ECOLE": "École", "EGLISE": "Église", "ETABLISSEMENT": "Établissement",
    "ETABLISSEMENTS": "Établissements", "PREVOYANCE": "Prévoyance", "PROPRIETAIRES": "Propriétaires", "PROPRIETAIRE": "Propriétaire",
    "COPROPRIETE": "Copropriété", "COPROPRIETAIRES": "Copropriétaires", "MACONNAIS": "Mâconnais", "MACON": "Mâcon", "SAONE": "Saône",
    "CREMANT": "Crémant", "REFORMEE": "Réformée", "PROTESTANTE": "Protestante", "CATHOLIQUE": "Catholique", "PAROISSE": "Paroisse", "DIOCESE": "Diocèse", "EVECHE": "Évêché", "ELECTRIQUE": "Électrique", "SOCIETES": "Sociétés", "CIVILE": "Civile", "COOPERATIVE": "Coopérative", "ELEVAGE": "Élevage", "HOPITAL": "Hôpital", "MINISTERE": "Ministère", "ECOLOGIE": "Écologie",
    "DEVELOPPEMENT": "Développement", "AMENAGEMENT": "Aménagement", "MODERE": "Modéré", "MODEREE": "Modérée", "GENERAL": "Général", "GENERALE": "Générale",
    "PRES": "Prés", "PRE": "Pré", "VALLEE": "Vallée", "ABBAYE": "Abbaye", "PRIEURE": "Prieuré", "CITE": "Cité", "COMMUNAUTE": "Communauté",
    "AGGLOMERATION": "Agglomération", "METROPOLE": "Métropole", "SECURITE": "Sécurité", "SANTE": "Santé", "PUBLIQUE": "Publique", "MUTUALITE": "Mutualité",
    "ASSOCIEES": "Associées", "ASSOCIES": "Associés", "REUNIS": "Réunis", "REUNIES": "Réunies", "DOMAINES": "Domaines", "BIENS": "Biens", "INDIVISION": "Indivision",
    "SYNDICAT": "Syndicat", "INTERCOMMUNAL": "Intercommunal", "ETUDES": "Études", "ETUDE": "Étude", "ESPERANCE": "Espérance", "FEDERATION": "Fédération",
    "CHENE": "Chêne", "CHENES": "Chênes", "FORET": "Forêt", "FORETS": "Forêts", "BEGUINES": "Béguines", "CELESTINS": "Célestins", "CHAPITRE": "Chapitre",
    "MECANIQUE": "Mécanique", "SERVICES": "Services", "REALISATIONS": "Réalisations", "GERANCE": "Gérance", "GESTION": "Gestion", "EPARGNE": "Épargne",
    "LOCATIVE": "Locative", "SOCIALE": "Sociale", "CREDIT": "Crédit", "CENTRE": "Centre", "SAINT": "Saint", "SAINTE": "Sainte", "ST": "St", "STE": "Ste",
    "BEAUNOIS": "Beaunois", "DIJONNAIS": "Dijonnais", "CHABLISIEN": "Chablisien", "CHALONNAIS": "Chalonnais", "TONNERROIS": "Tonnerrois", "AUXERROIS": "Auxerrois",
    "RHONE": "Rhône", "ISERE": "Isère", "ARDECHE": "Ardèche", "DROME": "Drôme", "NIEVRE": "Nièvre", "BRESSE": "Bresse", "MORVAN": "Morvan",
}
PLACES = {"COTE D OR": "Côte-d'Or", "COTE-D'OR": "Côte-d'Or", "SAONE ET LOIRE": "Saône-et-Loire", "SAONE-ET-LOIRE": "Saône-et-Loire", "BOURGOGNE FRANCHE COMTE": "Bourgogne-Franche-Comté", "BOURGOGNE-FRANCHE-COMTE": "Bourgogne-Franche-Comté", "FRANCHE COMTE": "Franche-Comté", "FRANCHE-COMTE": "Franche-Comté", "COTE DE NUITS": "Côte de Nuits", "COTE DE BEAUNE": "Côte de Beaune", "HAUTES COTES": "Hautes-Côtes"}


def fold(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    return "".join(c for c in value if unicodedata.category(c) != "Mn").upper()


def word_case(word: str, first: bool) -> str:
    bare = word.strip(".,;:()")
    if not bare: return word
    if bare in ACRONYMS or (len(bare) <= 4 and bare.isalpha() and not re.search(r"[AEIOUY]", bare)):
        return word.replace(bare, bare)  # keep capitals
    if bare in LOWER and not first: return word.replace(bare, bare.lower())
    if bare in ACCENTS: return word.replace(bare, ACCENTS[bare])
    if re.fullmatch(r"\d+[A-Z]*|[A-Z]{1,3}\d+[A-Z\d]*", bare): return word  # numbers and parcel references such as ZC0055
    return word.replace(bare, bare[:1] + bare[1:].lower())


def display_name(entity: str, legal_form: str = "", place_names: dict[str, str] | None = None, full_name: str | None = None) -> str:
    raw = re.sub(r"\s+", " ", (full_name or entity or "").strip()).upper()
    if not raw: return ""
    truncated = full_name is None and len(entity or "") >= 60
    form = (legal_form or "").strip().upper()
    tokens = [EXPAND.get(t, t) for t in raw.split(" ")]
    if tokens and tokens[0] == "ASS": tokens[0] = "ASSOCIATION"
    raw = " ".join(tokens)
    if form in LEGAL_FORMS and form not in tokens and tokens[0] not in SELF_DESCRIBED and tokens[0] not in LEGAL_FORMS and not set(tokens) & LEGAL_FORMS:
        raw = f"{form} {raw}"
    # whole place names first (commune names from the atlas, departments, regions): keep their own spelling
    text = raw
    names = dict(PLACES); names.update(place_names or {})
    protected = {}
    for key in sorted(names, key=len, reverse=True):
        pattern = r"(?<![A-Z0-9'])" + re.escape(key).replace(r"\-", r"[\- ]").replace(r"\ ", r"[\- ]") + r"(?![A-Z0-9])"
        if re.search(pattern, text):
            token = f"\u0001{len(protected)}\u0002"; protected[token] = names[key]; text = re.sub(pattern, token, text)
    # apostrophes the file turned into spaces: D OR → D'OR, L EGLISE → L'EGLISE (only before a word starting with a vowel or H)
    text = re.sub(r"(?<![A-Z])([DL]) (?=[AEIOUYH\u0001])", r"\1'", text)
    words = text.split(" ")
    out = []
    for i, word in enumerate(words):
        parts = re.split(r"([\-'])", word)
        cased = []
        for j, part in enumerate(parts):
            if part in "-'" or part.startswith("\u0001"): cased.append(part); continue
            if j >= 2 and parts[j - 1] == "'" and parts[j - 2] in {"D", "L"}:  # word after d' / l'
                cased.append(word_case(part, True)); continue
            if part in {"D", "L"} and j + 1 < len(parts) and parts[j + 1] == "'":
                cased.append(part if i == 0 and j == 0 else part.lower()); continue
            cased.append(word_case(part, i == 0 and j == 0))
        out.append("".join(cased))
    result = " ".join(out)
    for token, name in protected.items(): result = result.replace(token, name)
    result = re.sub(r"^([dl])'", lambda m: m.group(1).upper() + "'", result)
    return result + ("…" if truncated else "")


if __name__ == "__main__":
    tests = [("DES ANTES", "SCI"), ("COMMUNE DE VOSNE-ROMANEE", "COM"), ("DEPARTEMENT DE COTE D OR", "DEPT"), ("ETAT PAR DIRECTION DE L IMMOBILIER DE L ETAT", "ETAT"),
             ("SOC CIV DOMAINE HERITIERS LOUIS JADOT", "SC"), ("GFA DU DOMAINE VINCENT RAPET", "GFA"), ("DU DOMAINE BELGRAND LATOUR", "GFA"), ("BICHOT SA", "SA"),
             ("MEO CAMUZET FRERE ET SOEURS", "SARL"), ("ASS CULTUELLE DE L EGLISE REFORMEE DE DIJON BEAUNE ET LA COT", "ASSO"), ("SOCIETE NATIONALE SNCF", "SA"),
             ("PROPRIETAIRES DU BND 001 ZC0055", "AUPM"), ("HOSPICES CIVILS DE BEAUNE", "EPA")]
    for e, f in tests: print(f"{f:5} {e!r:65} -> {display_name(e, f, {'VOSNE-ROMANEE': 'Vosne-Romanée', 'BEAUNE': 'Beaune', 'DIJON': 'Dijon'})}")
