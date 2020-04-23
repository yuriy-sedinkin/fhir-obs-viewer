// Imports for webpack to find assets
import './app.css';
import './USAgov.gif';
import './lhncbc.jpg';

// "Real" imports
import * as moment from 'moment';
import * as catData from './categoryList';
import { saveAs } from 'file-saver';
import { ObservationsTable, administrativeGenderConcept } from './observations-table'
import { FhirBatchQuery } from "./fhir-batch-query";

const noResultsMsg = document.getElementById('noResults'),
  resultsSection = document.getElementById('results'),
  catLimitRow = document.getElementById('catSel'),
  testLimitRow = document.getElementById('testSel'),
  loadButton = document.getElementById('load'),
  downloadButton = document.getElementById('download'),
  performanceTuning = document.getElementById('performanceTuning');

let categoryLimits = true;

if (/[?&]tunable(&|$)/.test(window.location.search)) {
  performanceTuning.style.display = '';
}

new Def.Autocompleter.Prefetch('fhirServer', [
  'https://lforms-fhir.nlm.nih.gov/baseR4',
  'https://lforms-fhir.nlm.nih.gov/baseDstu3']);

var loincAC = new Def.Autocompleter.Search('loincTests',
  'https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search?type=question',
  {maxSelect: '*', matchListValue: true});

// Set up propulated values
var selectedTests = [['Weight', '29463-7'], ['Body height Measured', '3137-7'],
  ['Feeling down, depressed, or hopeless?', '44255-8'], ['Current smoker', '64234-8']];
for (var i=0, len=selectedTests.length; i<len; ++i) {
  var testData = selectedTests[i];
  // TBD -- These APIs are not documented.  We should probably add something to
  // the autocompleter for setting the state of a search list.
  loincAC.storeSelectedItem(testData[0], testData[1]);
  loincAC.addToSelectedArea(testData[0]);
}

var genderAC = new Def.Autocompleter.Prefetch('gender', administrativeGenderConcept.map(item => item.display), {
  codes: administrativeGenderConcept.map(item => item.code),
  maxSelect: '*'
});

// Category list
var categoryAC = new Def.Autocompleter.Prefetch('categories', catData.display,
  {codes: catData.codes});
categoryAC.setFieldToListValue('Vital Signs');

/**
 *  Used to show a message when there are no results to display.
 */
function showNonResultsMsg(msg) {
  noResultsMsg.innerText=msg;
  noResultsMsg.style.display = '';
  resultsSection.style.display = 'none';
  downloadButton.style.display = 'none';
}

/**
 *  Enables the display of the results portion of the page.
 */
function showResults() {
  noResultsMsg.style.display = 'none';
  resultsSection.style.display = '';
  downloadButton.style.display = '';
}

/**
 * Used to show loading progress
 * @param {number} percent
 */
function showProgress(percent) {
  showNonResultsMsg(`Loading observations... ${percent}%`);
}

/**
 * Minimum date of birth in ISO-8601 format to be <age> years old
 * @param {number} age
 * @return {string}
 */
function ageToBirthDateMin(age) {
  return moment().subtract(age+1, 'years').add(1, 'day').format('YYYY-MM-DD')
}

/**
 * Maximum date of birth in ISO-8601 format to be <age> years old
 * @param {number} age
 * @return {string}
 */
function ageToBirthDateMax(age) {
  return moment().subtract(age, 'years').format('YYYY-MM-DD')
}

const observationsTable = new ObservationsTable('resultsTable')

/**
 *  Handles the request to load the observations.
 */
export function loadObs() {
  loadButton.disabled = true;

  const maxPatientCount = document.getElementById('maxPatientCount').value;
  const maxPatientCondition = maxPatientCount ? `&_count=${maxPatientCount}` : '';
  const serviceBaseUrl = document.getElementById('fhirServer').value;
  const genderCodes = genderAC.getSelectedCodes().join(',');
  const genderCondition = genderCodes ? `&gender=${genderCodes}` : '';
  const ageFrom = document.getElementById('ageFrom').value;
  const ageTo = document.getElementById('ageTo').value;
  const ageCondition = (ageTo ? `&birthdate=ge${ageToBirthDateMin(+ageTo)}` : '')
    + (ageFrom ? `&birthdate=le${ageToBirthDateMax(+ageFrom)}` : '');
  const maxRequestsPerBatch = document.getElementById('maxRequestsPerBatch').value || undefined;
  const maxActiveRequests = document.getElementById('maxActiveRequests').value || undefined;
  const client = new FhirBatchQuery({serviceBaseUrl, maxRequestsPerBatch, maxActiveRequests});
  const perPatientPerTest = document.getElementById('perPatientPerTest').value || Number.POSITIVE_INFINITY;
  const conditions = `${maxPatientCondition}${genderCondition}${ageCondition}`;

  let codes, field;
  if (categoryLimits) {
    codes = categoryAC.getSelectedCodes();
    field = 'category';
  } else { // test codes instead of categories
    codes = loincAC.getSelectedCodes();
    field = 'code';
  }

  showNonResultsMsg('Searching patients...');

  client.getWithCache(`Patient?_elements=name,birthDate,gender${conditions}`, function (status, data) {
    if (status !== 200) {
      showNonResultsMsg('Could not load Patient list');
      loadButton.disabled = false;
    } else {
      if (!data.entry || !data.entry.length) {
        showNonResultsMsg('No matching Patients found.');
        loadButton.disabled = false;
      } else {
        let completedRequestCount = 0,
          allObservations = [],
          error = false;
        const patients = data.entry.map(item => item.resource),
          patientCount = patients.length,
          urlSuffixes = codes && codes.length > 0
            ? codes.map(code => `&_count=${perPatientPerTest}&${field}=${encodeURIComponent(code)}`)
            : [`&_count=1000`],
          suffixCount = urlSuffixes.length,
          totalRequestCount = patientCount * suffixCount;

        showProgress(0);

        for (let i = 0; i < patientCount; ++i) {
          const patient = patients[i];

          for (let j = 0; j < suffixCount; ++j) {
            const urlSuffix = urlSuffixes[j],
              index = i * suffixCount + j;

            client.getWithCache(
              `Observation?subject:reference=Patient/${patient.id}` +
              `&_sort=patient,code,-date&_elements=subject,effectiveDateTime,code,value,interpretation` + urlSuffix,
              (status, observations) => {
                if (status !== 200) {
                  client.clearPendingRequests();
                  loadButton.disabled = false;
                  error = true;
                  showNonResultsMsg('Could not load observation list');
                } else if (!error) {
                  showProgress(Math.floor(++completedRequestCount * 100 / totalRequestCount));
                  allObservations[index] = (observations.entry || []).map(item => item.resource);
                  if (completedRequestCount === totalRequestCount) {
                    observationsTable.fill({
                      patients: patients,
                      observations: [].concat.apply([], allObservations)
                    }, perPatientPerTest, serviceBaseUrl);
                    loadButton.disabled = false;
                    showResults();
                  }
                }
              });
          }
        }
      }
    }
  });
}

/**
 *  Handles the request to download the observations.
 */
export function downloadObs() {
  saveAs(observationsTable.getBlob(), 'observations.csv');
}

export function clearCache() {
  FhirBatchQuery.clearCache();
}

/**
 *  Handles the request to change the limit type selection (category or test
 *  type).
 * @param ev the change event
 */
function handleLimitSelection(ev) {
  setLimitType(ev.target.id === 'limit1');
}

/**
 *  Sets the limit type (category or test) and adjusts the display.
 * @param isCategory true if categories are to be used.
 */
function setLimitType(isCategory) {
  categoryLimits = isCategory;
  testLimitRow.style.display = categoryLimits ? 'none' : '';
  catLimitRow.style.display = categoryLimits ? '' : 'none';
}
setLimitType(false);

var categoryRadio = document.getElementById('limit1');
categoryRadio.addEventListener('change', handleLimitSelection);
document.getElementById('limit2').addEventListener('change', handleLimitSelection);

