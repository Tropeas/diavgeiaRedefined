const fs = require('co-fs')
const config = require('config')
const path = require('path')
const spawn = require('co-child-process')
const mongoURL = config.get('mongoURL')
const mongoDBName = config.get('mongoDBName')
const stdfs = require('fs')
const expandHomeDir = require('expand-home-dir')

const db = require('monk')(mongoURL + '/' + mongoDBName)
const co = require('co')
const wrap = require('co-monk')

const ONT = '<http://diavgeia.gov.gr/ontology/>'
const ELI = '<http://data.europa.eu/eli/ontology#>'
const LEG = '<http://legislation.di.uoa.gr/eli/>'

class Decision {
  constructor (fields, iun, version, unitIds, organizationId, benchmark = false) {
    this.fields = fields
    this.fields.iun = iun
    this.fields.version = version
    this.fields.unitIds = unitIds
    this.fields.organizationId = organizationId
    this.decisionString = ''
    this.verifierCounter = 1
    this.benchmark = benchmark
  }

  static getDecisions () {
    return co(function * () {
      var collection = wrap(db.collection('decisions'))
      var decisions = yield collection.find({}, { sort: {date: -1}, fields: { '_id': 0 } })
      return decisions
    })
  }

  static getLastBlockchainCommit () {
    return co(function * () {
      var collection = wrap(db.collection('blockchainCommits'))
      var commit = yield collection.findOne({}, {sort: {date: -1}, limit: 1})
      return commit
    })
  }

  static getAllBlockchainCommits () {
    return co(function * () {
      var collection = wrap(db.collection('blockchainCommits'))
      var commits = yield collection.find({}, {sort: {_id: -1}, fields: {'txId': 1, 'txIndex': 1}})
      return commits
    })
  }

  static getDecisionsByTxIndex (index) {
    return co(function * () {
      var collection = wrap(db.collection('decisions'))
      var decisions = yield collection.find({txIndex: parseInt(index)}, {sort: {date: -1}})
      return decisions
    })
  }

  _formatTriplet (ontology, propertyName, propertyValue, propertyRange, stringGreek = true, lastTriplet = false) {
    var str = '\t' + ontology + ':' + propertyName + ' '
    if (propertyRange === 'string' && stringGreek) {
      str += '"' + propertyValue + '"@el'
    } else if (propertyRange === 'string') {
      str += '"' + propertyValue + '"'
    } else if (propertyRange === 'number' || propertyRange === 'boolean') {
      str += propertyValue
    } else if (propertyRange === 'entity') {
      str += '<' + propertyValue + '>'
    } else if (propertyRange === 'integer') {
      str += '"' + propertyValue + '"^^<http://www.w3.org/2001/XMLSchema#integer>'
    }
    if (lastTriplet) {
      return str + '.\n\n'
    }
    return str + ';\n'
  }

  _writePrefixes () {
    const baseString = '@base <http://diavgeia.gov.gr/eli/decision/' + this.fields.iun + '/' + this.fields.version + '/>.\n'
    const ontString = '@prefix ont: ' + ONT + '.\n'
    const eliString = '@prefix eli: ' + ELI + '.\n'
    const legString = '@prefix leg: ' + LEG + '.\n\n'
    this.decisionString = baseString + ontString + eliString + legString
  }

  _writeGovernmentInstitutionsOptionalInfo () {
    if (this.fields.government_institution_general_administration) {
      this.decisionString += this._formatTriplet('ont', 'government_institution_general_administration', this.fields.government_institution_general_administration, 'string')
    }
    if (this.fields.government_institution_department) {
      this.decisionString += this._formatTriplet('ont', 'government_institution_department', this.fields.government_institution_department, 'string')
    }
    if (this.fields.government_institution_address) {
      this.decisionString += this._formatTriplet('ont', 'government_institution_address', this.fields.government_institution_address, 'string')
    }
    if (this.fields.government_institution_postalcode) {
      this.decisionString += this._formatTriplet('ont', 'government_institution_postalcode', this.fields.government_institution_postalcode, 'string', false)
    }
    if (this.fields.government_institution_phone) {
      this.decisionString += this._formatTriplet('ont', 'government_institution_phone', this.fields.government_institution_phone, 'string', false)
    }
    if (this.fields.government_institution_fax) {
      this.decisionString += this._formatTriplet('ont', 'government_institution_fax', this.fields.government_institution_fax, 'string', false)
    }
    if (this.fields.government_institution_website) {
      this.decisionString += this._formatTriplet('ont', 'government_institution_website', this.fields.government_institution_website, 'string', false)
    }
    if (this.fields.government_institution_email) {
      this.decisionString += this._formatTriplet('ont', 'government_institution_email', this.fields.government_institution_email, 'string', false)
    }
    if (this.fields.government_institution_information) {
      this.decisionString += this._formatTriplet('ont', 'government_institution_information', this.fields.government_institution_information, 'string')
    }
  }

  _writeSpecialProperties () {
    switch (this.fields.decision_type) {
      case 'Normative':
        this._writeNormativeType()
        if (this.fields.normative_number) {
          this.decisionString += this._formatTriplet('ont', 'normative_number', this.fields.normative_number, 'string', false)
        }
        this._writeFek()
        break
      case 'Circular':
        if (this.fields.circular_number) {
          this.decisionString += this._formatTriplet('ont', 'circular_number', this.fields.circular_number, 'string', false)
        }
        break
      case 'Appointment':
        if (this.fields.number_employees) {
          this.decisionString += this._formatTriplet('ont', 'number_employees', this.fields.number_employees, 'integer')
        }
        if (this.fields.appointment_employer_org) {
          this.decisionString += this._formatTriplet('ont', 'appointment_employer_org', this.fields.appointment_employer_org, 'string', false)
        }
        this._writeFek()
        break
      case 'Award':
        if (this.fields.expense_amount && this.fields.expense[0].afm) {
          this.decisionString += this._formatTriplet('ont', 'has_expense', 'Expense/1', 'entity')
        }
        if (this.fields.has_related_declaration_summary) {
          // TODO This is not a valid decision format, as we miss the version.
          // The following approach should be followed:
          // Combine the current Diavgeia api (https://diavgeia.gov.gr/luminapi/api/decisions/{{IUN}}) with the rdf store.
          // This is the case, because IUN may refer to an old pdf decision or to a new .n3 decision.
          let version = ''
          let iun = this.fields.has_related_declaration_summary + '/'
          this.decisionString += '\tont:has_related_declaration_summary <http://diavgeia.gov.gr/eli/decision/' + iun + version + '>;\n'
        }
        break
      case 'LegislativeDecree':
        if (this.fields.legislative_decree_number) {
          this.decisionString += this._formatTriplet('ont', 'legislative_decree_number', this.fields.legislative_decree_number, 'string', false)
        }
        this._writeFek()
        break
      case 'OtherDecisions':
      case 'OtherDevelopmentLaw':
        this._writeNormativeType()
        if (this.fields.publish_via) {
          this.decisionString += this._formatTriplet('ont', 'publish_via', this.fields.publish_via, 'string')
        }
        if (this.fields.publish_via === 'Στο ΦΕΚ') {
          this._writeFek()
        }
        break
      case 'ServiceChange':
        if (this.fields.service_change_decision_type) {
          this.decisionString += this._formatTriplet('ont', 'service_change_decision_type', this.fields.service_change_decision_type, 'string')
        }
        this._writeFek()
        break
      case 'OccupationInvitation':
        if (this.fields.vacancy_opening_type) {
          this.decisionString += this._formatTriplet('ont', 'vacancy_opening_type', this.fields.vacancy_opening_type, 'string')
        }
        if (this.fields.has_related_undertaking) {
          // TODO This is not a valid decision format, as we miss the version.
          // The following approach should be followed:
          // Combine the current Diavgeia api (https://diavgeia.gov.gr/luminapi/api/decisions/{{IUN}}) with the rdf store.
          // This is the case, because IUN may refer to an old pdf decision or to a new .n3 decision.
          let version = ''
          let iun = this.fields.has_related_undertaking + '/'
          this.decisionString += '\tont:has_related_undertaking <http://diavgeia.gov.gr/eli/decision/' + iun + version + '>;\n'
        }
        break
      case 'Records':
        if (this.fields.record_subject) {
          this.decisionString += this._formatTriplet('ont', 'record_subject', this.fields.record_subject, 'string')
        }
        if (this.fields.record_number) {
          this.decisionString += this._formatTriplet('ont', 'record_number', this.fields.record_number, 'string', false)
        }
        break
      case 'BalanceAccount':
        if (this.fields.balance_account_type) {
          this.decisionString += this._formatTriplet('ont', 'balance_account_type', this.fields.balance_account_type, 'string')
        }
        if (this.fields.balance_account_time_period) {
          this.decisionString += this._formatTriplet('ont', 'balance_account_time_period', this.fields.balance_account_time_period, 'string')
        }
        if (this.fields.financial_year) {
          this.decisionString += this._formatTriplet('ont', 'financial_year', this.fields.financial_year, 'string', false)
        }
        var isBalanceAccountApprovalForOrg = this.fields.is_balance_account_approval_for_org && Boolean(this.fields.is_balance_account_approval_for_org)
        if (isBalanceAccountApprovalForOrg) {
          this.decisionString += this._formatTriplet('ont', 'is_balance_account_approval_for_org', isBalanceAccountApprovalForOrg, 'boolean')
          // TODO this should be the UnitID, not the name and this can be found by the current production code of Diavgeia
          this.decisionString += this._formatTriplet('ont', 'has_related_institution', this.fields.has_related_institution, 'string', false)
        } else {
          this.decisionString += this._formatTriplet('ont', 'is_balance_account_approval_for_org', false, 'boolean')
        }
        break
      case 'BudgetApproval':
        if (this.fields.budget_type) {
          this.decisionString += this._formatTriplet('ont', 'budget_type', this.fields.budget_type, 'string')
        }
        if (this.fields.budget_category) {
          this.decisionString += this._formatTriplet('ont', 'budget_category', this.fields.budget_category, 'string')
        }
        if (this.fields.financial_year) {
          this.decisionString += this._formatTriplet('ont', 'financial_year', this.fields.financial_year, 'string', false)
        }
        isBalanceAccountApprovalForOrg = this.fields.is_balance_account_approval_for_org && Boolean(this.fields.is_balance_account_approval_for_org)
        if (isBalanceAccountApprovalForOrg) {
          this.decisionString += this._formatTriplet('ont', 'is_balance_account_approval_for_org', isBalanceAccountApprovalForOrg, 'boolean')
          // TODO this should be the UnitID, not the name and this can be found by the current production code of Diavgeia
          this.decisionString += this._formatTriplet('ont', 'has_related_institution', this.fields.has_related_institution, 'string', false)
        } else {
          this.decisionString += this._formatTriplet('ont', 'is_balance_account_approval_for_org', false, 'boolean')
        }
        break
      case 'CollegialBodyCommisionWorkingGroup':
        if (this.fields.collegial_body_party_type) {
          this.decisionString += this._formatTriplet('ont', 'collegial_body_party_type', this.fields.collegial_body_party_type, 'string')
        }
        var decisionType = this.fields.collegial_body_decision_type
        if (decisionType) {
          this.decisionString += this._formatTriplet('ont', 'collegial_body_decision_type', decisionType, 'string')
          if (this.fields.collegial_body_refund && this.fields.expense_currency) {
            this.decisionString += this._formatTriplet('ont', 'collegial_body_refund', this.fields.collegial_body_refund, 'string', false)
            this.decisionString += this._formatTriplet('ont', 'collegial_body_currency', this.fields.expense_currency, 'string')
          }
        }
        this._writeFek()
        break
      case 'CommisionWarrant':
        this.fields.expense.forEach((expense, i) => {
          if (expense.kae && expense.expense_amount && expense.expense_currency && expense.index) {
            this.decisionString += this._formatTriplet('ont', 'has_expense_with_kae', 'ExpenseWithKae/' + (i + 1), 'entity')
          }
        })
        if (this.fields.primary_officer) {
          this.decisionString += this._formatTriplet('ont', 'primary_officer', this.fields.primary_officer, 'string')
        }
        if (this.fields.secondary_officer) {
          this.decisionString += this._formatTriplet('ont', 'secondary_officer', this.fields.secondary_officer, 'string')
        }
        if (this.fields.budget_category) {
          this.decisionString += this._formatTriplet('ont', 'budget_category', this.fields.budget_category, 'string')
        }
        if (this.fields.financial_year) {
          this.decisionString += this._formatTriplet('ont', 'financial_year', this.fields.financial_year, 'string', false)
        }
        break
      case 'Contract':
        var contractDecisionType = this.fields.contract_decision_type
        if (contractDecisionType) {
          this.decisionString += this._formatTriplet('ont', 'contract_decision_type', contractDecisionType, 'string')
          if (this.fields.number_employees) {
            this.decisionString += this._formatTriplet('ont', 'number_employees', this.fields.number_employees, 'integer')
          }
          if (contractDecisionType !== 'Σύμβαση Ιδιωτικού Δικαίου Αορίστου Χρόνου') {
            if (this.fields.contract_is_co_funded) {
              this.decisionString += this._formatTriplet('ont', 'contract_is_co_funded', Boolean(this.fields.contract_is_co_funded), 'boolean')
            } else {
              this.decisionString += this._formatTriplet('ont', 'contract_is_co_funded', false, 'boolean')
            }
            if (contractDecisionType === 'Σύμβαση Έργου') {
              if (this.fields.expense_amount && this.fields.expense[0].afm) {
                this.decisionString += this._formatTriplet('ont', 'has_expense', 'Expense/1', 'entity')
              }
              this.decisionString += '\tont:contract_start "' + this.fields.contract_start + '"^^<http://www.w3.org/2001/XMLSchema#date>;\n'
              this.decisionString += '\tont:contract_end "' + this.fields.contract_end + '"^^<http://www.w3.org/2001/XMLSchema#date>;\n'
            }
          }
        }
        break
      case 'DeclarationSummary':
        if (this.fields.expense_amount && this.fields.expense_currency) {
          this.decisionString += this._formatTriplet('ont', 'has_expense', 'Expense/1', 'entity')
        }
        if (this.fields.tendering_procedure) {
          this.decisionString += this._formatTriplet('ont', 'tendering_procedure', this.fields.tendering_procedure, 'string')
        }
        if (this.fields.selection_criterion) {
          this.decisionString += this._formatTriplet('ont', 'selection_criterion', this.fields.selection_criterion, 'string')
        }
        if (this.fields.contract_type) {
          this.decisionString += this._formatTriplet('ont', 'contract_type', this.fields.contract_type, 'string')
        }
        if (this.fields.government_institution_budget_code) {
          this.decisionString += this._formatTriplet('ont', 'government_institution_budget_code', this.fields.government_institution_budget_code, 'string')
        }
        break
      case 'DonationGrant':
        if (this.fields.donation_type) {
          this.decisionString += this._formatTriplet('ont', 'donation_type', this.fields.donation_type, 'string')
        }
        if (this.fields.kae) {
          this.decisionString += this._formatTriplet('ont', 'kae', this.fields.kae, 'string', false)
        }
        this.fields.expense.forEach((expense, i) => {
          if (expense.expense_amount && expense.expense_currency && this.fields.sponsor_afm && this.fields.sponsor_name) {
            this.decisionString += this._formatTriplet('ont', 'has_expense', 'Expense/' + (i + 1), 'entity')
          }
        })

        break
      case 'SpatialPlanningDecisions':
        if (this.fields.municipality) {
          let kallikratisLinking = require('../../assets/kallikratis.json')
          if (this.fields.municipality in kallikratisLinking) {
            this.decisionString += this._formatTriplet('ont', 'has_municipality', kallikratisLinking[this.fields.municipality], 'entity')
          }
        }
        if (this.fields.spatial_planning_decision_type) {
          this.decisionString += this._formatTriplet('ont', 'spatial_planning_decision_type', this.fields.spatial_planning_decision_type, 'string')
        }
        break
      case 'ExpenditureApproval':
        this.fields.expense.forEach((expense, i) => {
          if (expense.afm && expense.expense_amount && expense.expense_currency && expense.index && expense.sponsored) {
            this.decisionString += this._formatTriplet('ont', 'has_expense', 'Expense/' + (i + 1), 'entity')
          }
        })
        if (this.fields.has_related_undertaking) {
          // TODO This is not a valid decision format, as we miss the version.
          // The following approach should be followed:
          // Combine the current Diavgeia api (https://diavgeia.gov.gr/luminapi/api/decisions/{{IUN}}) with the rdf store.
          // This is the case, because IUN may refer to an old pdf decision or to a new .n3 decision.
          let version = ''
          let iun = this.fields.has_related_undertaking + '/'
          this.decisionString += '\tont:has_related_undertaking <http://diavgeia.gov.gr/eli/decision/' + iun + version + '>;\n'
        }
        break
      case 'GeneralSpecialSecretaryMonocraticBody':
        if (this.fields.expense_amount && this.fields.expense_currency) {
          this.decisionString += this._formatTriplet('ont', 'has_expense', 'Expense/1', 'entity')
        }
        if (this.fields.position) {
          this.decisionString += this._formatTriplet('ont', 'position', this.fields.position, 'string')
        }
        if (this.fields.position_decision_type) {
          this.decisionString += this._formatTriplet('ont', 'position_decision_type', this.fields.position_decision_type, 'string')
        }
        if (this.fields.position_org) {
          this.decisionString += this._formatTriplet('ont', 'position_org', this.fields.position_org, 'string')
        }
        break
      case 'OwnershipTransferOfAssets':
        let sponsorFieldsSet = this.fields.sponsor_afm && this.fields.sponsor_name && this.fields.sponsor_afm_type
        let atLeastOneSponsored = this.fields.expense[0].afm && this.fields.expense[0].afm_type && this.fields.expense[0].index
        if (sponsorFieldsSet && atLeastOneSponsored && this.fields.asset_name) {
          this.decisionString += this._formatTriplet('ont', 'has_expense', 'Expense/1', 'entity')
          this.decisionString += this._formatTriplet('ont', 'asset_name', this.fields.asset_name, 'string')
        }
        break
      case 'SuccessfulAppointedRunnerUpList':
        // TODO This is not a valid decision format, as we miss the version.
        // The following approach should be followed:
        // Combine the current Diavgeia api (https://diavgeia.gov.gr/luminapi/api/decisions/{{IUN}}) with the rdf store.
        // This is the case, because IUN may refer to an old pdf decision or to a new .n3 decision.
        // Moreover you should check that decision is an OccupationInvitation
        if (this.fields.has_related_occupation_invitation) {
          let version = ''
          let iun = this.fields.has_related_occupation_invitation + '/'
          this.decisionString += '\tont:has_related_occupation_invitation <http://diavgeia.gov.gr/eli/decision/' + iun + version + '>;\n'
        }
        break
      case 'Undertaking':
        if (this.fields.financial_year) {
          this.decisionString += this._formatTriplet('ont', 'financial_year', this.fields.financial_year, 'string', false)
        }
        if (this.fields.budget_category) {
          this.decisionString += this._formatTriplet('ont', 'budget_category', this.fields.budget_category, 'string')
        }
        if (this.fields.entry_number) {
          this.decisionString += this._formatTriplet('ont', 'entry_number', this.fields.entry_number, 'string', false)
        }
        this.decisionString += this._formatTriplet('ont', 'partialead', Boolean(this.fields.partialead), 'boolean')
        this.decisionString += this._formatTriplet('ont', 'recalled_expense', Boolean(this.fields.recalled_expense), 'boolean')
        this.fields.expense.forEach((expense, i) => {
          if (expense.afm && expense.kae && expense.expense_amount && expense.expense_currency && expense.kae_budget_remainder && expense.kae_credit_remainder && expense.index && expense.afm_type && expense.sponsored) {
            this.decisionString += this._formatTriplet('ont', 'has_expense_with_kae', 'ExpenseWithKae/' + (i + 1), 'entity')
          }
        })
        break
      case 'WorkAssignmentSupplyServicesStudies':
        if (this.fields.work_assignment_etc_category) {
          this.decisionString += this._formatTriplet('ont', 'work_assignment_etc_category', this.fields.work_assignment_etc_category, 'string')
        }
        if (this.fields.has_related_undertaking) {
          // TODO This is not a valid decision format, as we miss the version.
          // The following approach should be followed:
          // Combine the current Diavgeia api (https://diavgeia.gov.gr/luminapi/api/decisions/{{IUN}}) with the rdf store.
          // This is the case, because IUN may refer to an old pdf decision or to a new .n3 decision.
          // Moreover you should check that decision is an Undertaking
          let version = ''
          let iun = this.fields.has_related_undertaking + '/'
          this.decisionString += '\tont:has_related_undertaking <http://diavgeia.gov.gr/eli/decision/' + iun + version + '>;\n'
        }
        if (this.fields.expense[0].afm && this.fields.expense[0].sponsored && this.fields.expense[0].index && this.fields.expense[0].afm_type && this.fields.expense_amount && this.fields.expense_currency) {
          this.decisionString += this._formatTriplet('ont', 'has_expense', 'Expense/1', 'entity')
        }
        break
      case 'Opinion':
        if (this.fields.opinion_question_number) {
          this.decisionString += this._formatTriplet('ont', 'opinion_question_number', this.fields.opinion_question_number, 'string')
        }
        if (this.fields.opinion_summary) {
          this.decisionString += this._formatTriplet('ont', 'opinion_summary', this.fields.opinion_summary, 'string')
        }
        if (this.fields.opinion_history) {
          this.decisionString += this._formatTriplet('ont', 'opinion_history', this.fields.opinion_history, 'string')
        }
        if (this.fields.opinion_analysis) {
          this.decisionString += this._formatTriplet('ont', 'opinion_analysis', this.fields.opinion_analysis, 'string')
        }
        if (this.fields.opinion_conclusion) {
          this.decisionString += this._formatTriplet('ont', 'opinion_conclusion', this.fields.opinion_conclusion, 'string')
        }
        if (this.fields.opinion_government_institution_type) {
          this.decisionString += this._formatTriplet('ont', 'opinion_government_institution_type', this.fields.opinion_government_institution_type, 'string')
        }
        break
      case 'PaymentFinalisation':
        if (this.fields.payment_number) {
          this.decisionString += this._formatTriplet('ont', 'payment_number', this.fields.payment_number, 'string', false)
        }
        if (this.fields.financial_year) {
          this.decisionString += this._formatTriplet('ont', 'financial_year', this.fields.financial_year, 'string', false)
        }
        if (this.fields.reason_multiple_afm_ignorance) {
          this.decisionString += this._formatTriplet('ont', 'reason_multiple_afm_ignorance', this.fields.reason_multiple_afm_ignorance, 'string')
          if (this.fields.multiple_afm_ignorance_text) {
            this.decisionString += this._formatTriplet('ont', 'multiple_afm_ignorance_text', this.fields.multiple_afm_ignorance_text, 'string', true)
          }
        }
        if (this.fields.organizationSponsorAfm && this.fields.organizationSponsorAfmType && this.fields.organizationSponsorName) {
          this.fields.expense.forEach((expense, i) => {
            if (((expense.afm && expense.afm_type && expense.name) || this.fields.reason_multiple_afm_ignorance) && expense.expense_amount && expense.expense_currency) {
              this.decisionString += this._formatTriplet('ont', 'has_expense', 'Expense/' + (i + 1), 'entity')
            }
          })
        }
        break
    }
  }

  _writeFek () {
    if (this.fields.fek_number && this.fields.fek_issue && this.fields.fek_year) {
      this.decisionString += this._formatTriplet('ont', 'fek_number', this.fields.fek_number, 'string', false)
      this.decisionString += this._formatTriplet('ont', 'fek_issue', this.fields.fek_issue, 'string')
      this.decisionString += this._formatTriplet('ont', 'fek_year', this.fields.fek_year, 'string', false)
    }
  }

  _writeNormativeType () {
    if (this.fields.normative_number) {
      this.decisionString += this._formatTriplet('ont', 'normative_type', this.fields.normative_type, 'string')
    }
  }

  _writeGeneralInfo () {
    // General Information
    this.decisionString += '<> a ont:' + this.fields.decision_type + ';\n'
    this.decisionString += this._formatTriplet('ont', 'version', this.fields.version, 'string', false)
    this.decisionString += this._formatTriplet('ont', 'iun', this.fields.iun, 'string')
    this.decisionString += this._formatTriplet('eli', 'title', this.fields.title, 'string')
    this.decisionString += this._formatTriplet('ont', 'has_private_data', Boolean(this.fields.has_private_data), 'boolean')
    this.decisionString += this._formatTriplet('ont', 'government_institution_name', this.fields.government_institution_name, 'string')
    this.decisionString += this._formatTriplet('ont', 'protocol_number', this.fields.protocol_number, 'string')
    this._writeGovernmentInstitutionsOptionalInfo()
    if (this.fields.decision_call) {
      this.decisionString += this._formatTriplet('ont', 'decision_call', this.fields.decision_call, 'string')
    }
    this.fields.thematic_category.forEach((thematicCategory) => {
      this.decisionString += this._formatTriplet('ont', 'thematic_category', thematicCategory, 'string', false)
    })
    this.fields.unitIds.forEach((unitId) => {
      this.decisionString += this._formatTriplet('ont', 'unit_id', unitId, 'string', false)
    })
    this.decisionString += this._formatTriplet('ont', 'organization_id', this.fields.organizationId, 'string', false)
    // Link Decision with its PreConsideration, Considerations, Decisions and AfterDecision
    if (this.fields.preconsideration) {
      this.decisionString += this._formatTriplet('ont', 'has_preconsideration', 'Preconsideration', 'entity')
    }

    if (this.fields.considerations) {
      this.fields.considerations.forEach((v, i) => {
        if (v.text) {
          this.decisionString += this._formatTriplet('ont', 'has_considered', 'Consideration/' + (i + 1), 'entity')
        }
      })
    }

    if (this.fields.decisions) {
      // Because Opinions do not have decisions
      this.fields.decisions.forEach((v, i) => {
        if (v.text) {
          this.decisionString += this._formatTriplet('ont', 'has_decided', 'Decision/' + (i + 1), 'entity')
        }
      })
    }

    if (this.fields.afterconsideration) {
      this.decisionString += this._formatTriplet('ont', 'has_afterdecision', 'AfterDecision', 'entity')
    }

    // Recipients
    if (this.fields.internal_distr) {
      this.fields.internal_distr.forEach((v, i) => {
        if (v.name) {
          this.decisionString += this._formatTriplet('ont', 'internal_distribution', v.name, 'string')
        }
      })
    }

    if (this.fields.recipient_for_share) {
      this.fields.recipient_for_share.forEach((v, i) => {
        if (v.name) {
          this.decisionString += this._formatTriplet('ont', 'recipient_for_share', v.name, 'string')
        }
      })
    }

    if (this.fields.recipient) {
      this.fields.recipient.forEach((v, i) => {
        if (v.name) {
          this.decisionString += this._formatTriplet('ont', 'recipient', v.name, 'string')
        }
      })
    }

    // Signers
    if (this.fields.signer) {
      this.fields.signer.forEach((v, i) => {
        if (v.text) {
          this.decisionString += this._formatTriplet('ont', 'signed_by', 'Signer/' + (i + 1), 'entity')
        }
      })
    }

    // Present
    if (this.fields.present) {
      this.fields.present.forEach((v, i) => {
        if (v.text) {
          this.decisionString += this._formatTriplet('ont', 'has_present', 'Present/' + (i + 1), 'entity')
        }
      })
    }

    // Verification
    if (this.fields.verification) {
      this.fields.verification.forEach((v, i) => {
        if (!v.has_text || !v.index) {
          return
        }
        let signerIndexes = []
        // Find Signer Indexes
        Object.keys(v).map(key => {
          if (!isNaN(parseInt(key, 10))) {
            signerIndexes.push(key)
          }
        })
        for (let i = 0; i < signerIndexes.length; i++) {
          let signerIndex = signerIndexes[i]
          if (v[signerIndex] && v[signerIndex].signer_name && v[signerIndex].signer_job) {
            this.decisionString += this._formatTriplet('ont', 'has_verified', 'Verification/' + v.index, 'entity')
            break
          }
        }
      })
    }

    if (!this.benchmark) {
      this._writeSpecialProperties()
    }

    // Dates
    var date = new Date()
    var dateString = date.toISOString()
    var submissionTimestamp = date.getTime()
    this.decisionString += this._formatTriplet('ont', 'submission_timestamp', submissionTimestamp, 'string', false)
    dateString = dateString.substring(0, dateString.indexOf('T'))
    this.decisionString += '\teli:date_publication "' + dateString + '"^^<http://www.w3.org/2001/XMLSchema#date>.\n\n'
  }

  _formatLinking (legislation) {
    if (legislation.type === 'dvg') {
      // TODO This is not a valid decision format, as we miss the version.
      // The following approach should be followed:
      // Combine the current Diavgeia api (https://diavgeia.gov.gr/luminapi/api/decisions/{{IUN}}) with the rdf store.
      // This is the case, because IUN may refer to an old pdf decision or to a new .n3 decision.
      let version = ''
      let iun = legislation.IUN + '/'
      return '\tont:considers <http://diavgeia.gov.gr/eli/decision/' + iun + version + '>;\n'
    }

    let articleParagraph = ''
    if (legislation.article) {
      articleParagraph = '\\/article\\/' + legislation.article
      if (legislation.paragraph) {
        articleParagraph += '\\/paragraph\\/' + legislation.paragraph
      }
    }
    return '\tont:considers leg:' + legislation.type + '\\/' + legislation.year + '\\/' + legislation.number + articleParagraph + ';\n'
  }

  _hasLegislationLinking (legislation) {
    let validDvgLinking = legislation.type === 'dvg' && legislation.IUN
    let validLegLinking = legislation.type && legislation.type !== 'dvg' && legislation.year && legislation.number
    return (validLegLinking || validDvgLinking)
  }

  _writeDecisionBody () {
    // PreConsideration Body
    if (this.fields.preconsideration) {
      this.decisionString += '<PreConsideration> a ont:PreConsideration;\n'
      this.decisionString += this._formatTriplet('ont', 'has_text', this.fields.preconsideration, 'string', true, true)
    }
    // Considerations Body
    if (this.fields.considerations) {
      this.fields.considerations.forEach((legislation) => {
        if (legislation.text) {
          this.decisionString += '<Consideration/' + legislation.index + '> a ont:Consideration;\n'
          if (this._hasLegislationLinking(legislation)) {
            this.decisionString += this._formatLinking(legislation)
          }
          this.decisionString += this._formatTriplet('ont', 'has_text', legislation.text, 'string', true, true)
        }
      })
    }
    // Decisions Body
    if (this.fields.decisions) {
      // Because Opinions do not have decisions
      this.fields.decisions.forEach((legislation) => {
        if (legislation.text) {
          this.decisionString += '<Decision/' + legislation.index + '> a ont:Decision;\n'
          if (this._hasLegislationLinking(legislation)) {
            this.decisionString += this._formatLinking(legislation)
          }
          this.decisionString += this._formatTriplet('ont', 'has_text', legislation.text, 'string', true, true)
        }
      })
    }
    // AfterConsideration Body
    if (this.fields.afterconsideration) {
      this.decisionString += '<AfterConsideration> a ont:AfterConsideration;\n'
      this.decisionString += this._formatTriplet('ont', 'has_text', this.fields.afterconsideration, 'string', true, true)
    }
  }

  _writeRestEntities () {
    // Signers
    if (this.fields.signer) {
      this.fields.signer.forEach((signer) => {
        if (signer.name) {
          this.decisionString += '<Signer/' + signer.index + '> a ont:Signer;\n'
          this.decisionString += this._formatTriplet('ont', 'signer_name', signer.name, 'string')
          this.decisionString += this._formatTriplet('ont', 'signer_job', signer.job, 'string', true, true)
        }
      })
    }
    // Present
    if (this.fields.present) {
      this.fields.present.forEach((present) => {
        if (present.name) {
          this.decisionString += '<Present/' + present.index + '> a ont:Present;\n'
          this.decisionString += this._formatTriplet('ont', 'present_name', present.name, 'string')
          this.decisionString += this._formatTriplet('ont', 'present_title', present.role, 'string', true, true)
        }
      })
    }
    // Verifier
    if (this.fields.verification) {
      this.fields.verification.forEach((v, i) => {
        var perSignerIndex = {}
        if (!v.has_text || !v.index) {
          return
        }
        let signerIndexes = []
        // Find Signer Indexes
        Object.keys(v).map(key => {
          if (!isNaN(parseInt(key, 10))) {
            signerIndexes.push(key)
          }
        })
        this.decisionString += '<Verification/' + (parseInt(i) + 1) + '> a ont:Verification;\n'
        signerIndexes.map(signerIndex => {
          if (v[signerIndex] && v[signerIndex].signer_name && v[signerIndex].signer_job) {
            this.decisionString += this._formatTriplet('ont', 'verified_by', 'Verifier/' + this.verifierCounter, 'entity')
            perSignerIndex[signerIndex] = this.verifierCounter
            this.verifierCounter ++
          }
        })
        this.decisionString += this._formatTriplet('ont', 'has_text', v.has_text, 'string', true, true)
        signerIndexes.map((signerIndex, _index) => {
          if (v[signerIndex] && v[signerIndex].signer_name && v[signerIndex].signer_job) {
            this.decisionString += '<Verifier/' + perSignerIndex[signerIndex] + '> a ont:Verifier;\n'
            this.decisionString += this._formatTriplet('ont', 'verifier_job', v[signerIndex].signer_job, 'string')
            this.decisionString += this._formatTriplet('ont', 'verifier_name', v[signerIndex].signer_name, 'string', true, true)
          }
        })
      })
    }
    // Expenses
    switch (this.fields.decision_type) {
      case 'Award':
        if (this.fields.expense_amount && this.fields.expense[0].afm) {
          this.decisionString += '<Expense/1> a ont:Expense;\n'
          this.decisionString += this._formatTriplet('ont', 'expense_amount', this.fields.expense_amount, 'string', false)
          this.fields.expense.forEach((expense, i) => {
            if (expense.afm) {
              this.decisionString += this._formatTriplet('ont', 'has_sponsored', 'Sponsored/' + (i + 1), 'entity')
            }
          })
          this.decisionString += this._formatTriplet('ont', 'expense_amount_currency', this.fields.expense_currency, 'string', true, true)

          // Sponsored
          this.fields.expense.forEach((expense) => {
            if (expense.afm && expense.afm_type && expense.name && expense.index) {
              this.decisionString += '<Sponsored/' + expense.index + '> a ont:Sponsored;\n'
              this.decisionString += this._formatTriplet('ont', 'afm', expense.afm, 'string', false)
              this.decisionString += this._formatTriplet('ont', 'afm_type', expense.afm_type, 'string')
              this.decisionString += this._formatTriplet('ont', 'name', expense.name, 'string', true, true)
            }
          })
        }
        break
      case 'CommisionWarrant':
        this.fields.expense.forEach((expense) => {
          if (expense.kae && expense.expense_amount && expense.expense_currency && expense.index) {
            this.decisionString += '<ExpenseWithKae/' + expense.index + '> a ont:ExpenseWithKae;\n'
            this.decisionString += this._formatTriplet('ont', 'expense_amount', expense.expense_amount, 'string', false)
            this.decisionString += this._formatTriplet('ont', 'expense_amount_currency', expense.expense_currency, 'string', true)
            this.decisionString += this._formatTriplet('ont', 'kae', expense.kae, 'string', false, true)
          }
        })
        break
      case 'Contract':
        if (this.fields.expense_amount && this.fields.expense[0].afm) {
          this.decisionString += '<Expense/1> a ont:Expense;\n'
          this.decisionString += this._formatTriplet('ont', 'expense_amount', this.fields.expense_amount, 'string', false)
          this.fields.expense.forEach((expense, i) => {
            if (expense.afm) {
              this.decisionString += this._formatTriplet('ont', 'has_sponsored', 'Sponsored/' + (i + 1), 'entity')
            }
          })
          this.decisionString += this._formatTriplet('ont', 'expense_amount_currency', this.fields.expense_currency, 'string', true, true)

          // Sponsored
          this.fields.expense.forEach((expense) => {
            if (expense.afm && expense.afm_type && expense.name && expense.index) {
              this.decisionString += '<Sponsored/' + expense.index + '> a ont:Sponsored;\n'
              this.decisionString += this._formatTriplet('ont', 'afm', expense.afm, 'string', false)
              this.decisionString += this._formatTriplet('ont', 'afm_type', expense.afm_type, 'string')
              this.decisionString += this._formatTriplet('ont', 'name', expense.name, 'string', true, true)
            }
          })
        }
        break
      case 'DeclarationSummary':
        if (this.fields.expense_amount && this.fields.expense_currency) {
          this.decisionString += '<Expense/1> a ont:Expense;\n'
          if (this.fields.cpv) {
            this.decisionString += this._formatTriplet('ont', 'cpv', this.fields.cpv, 'string', false)
          }
          this.decisionString += this._formatTriplet('ont', 'expense_amount', this.fields.expense_amount, 'string', false)
          this.decisionString += this._formatTriplet('ont', 'expense_amount_currency', this.fields.expense_currency, 'string', true, true)
        }
        break
      case 'DonationGrant':
        // TODO why Diavgeia supports only 1 amount of money for all expenses??
        this.fields.expense.forEach((expense, i) => {
          this.decisionString += '<Expense/' + (i + 1) + '> a ont:Expense;\n'
          if (expense.afm && expense.afm_type && expense.expense_amount && expense.expense_currency) {
            this.decisionString += this._formatTriplet('ont', 'has_sponsored', 'Sponsored/' + (i + 1), 'entity')
          }
          this.decisionString += this._formatTriplet('ont', 'has_organization_sponsor', 'OrganizationSponsor/1', 'entity')
          this.decisionString += this._formatTriplet('ont', 'expense_amount', expense.expense_amount, 'string', false)
          this.decisionString += this._formatTriplet('ont', 'expense_amount_currency', expense.expense_currency, 'string', true, true)
        })

        // OrganizationSponsor
        this.decisionString += '<OrganizationSponsor/1> a ont:OrganizationSponsor;\n'
        this.decisionString += this._formatTriplet('ont', 'afm_type', this.fields.sponsor_afm_type, 'string')
        var afm = this.fields.sponsor_afm
        if (afm) {
          // Organization without afm
          this.decisionString += this._formatTriplet('ont', 'afm', this.fields.sponsor_afm, 'string', false)
        }
        this.decisionString += this._formatTriplet('ont', 'name', this.fields.sponsor_name, 'string', true, true)

        // Sponsored
        this.fields.expense.forEach((expense, i) => {
          if (expense.afm && expense.afm_type && expense.sponsored && expense.index) {
            this.decisionString += '<Sponsored/' + (i + 1) + '> a ont:Sponsored;\n'
            this.decisionString += this._formatTriplet('ont', 'afm', expense.afm, 'string', false)
            this.decisionString += this._formatTriplet('ont', 'afm_type', expense.afm_type, 'string')
            this.decisionString += this._formatTriplet('ont', 'name', expense.sponsored, 'string', true, true)
          }
        })
        break
      case 'ExpenditureApproval':
        this.fields.expense.forEach((expense) => {
          if (expense.afm && expense.expense_amount && expense.expense_currency && expense.index && expense.sponsored) {
            this.decisionString += '<Expense/' + expense.index + '> a ont:Expense;\n'
            this.decisionString += this._formatTriplet('ont', 'expense_amount', expense.expense_amount, 'string', false)
            this.decisionString += this._formatTriplet('ont', 'expense_amount_currency', expense.expense_currency, 'string', true)
            if (expense.kae) {
              this.decisionString += this._formatTriplet('ont', 'kae', expense.kae, 'string', false)
            }
            if (expense.cpv) {
              this.decisionString += this._formatTriplet('ont', 'cpv', expense.cpv, 'string')
            }
            this.decisionString += this._formatTriplet('ont', 'has_sponsored', 'Sponsored/' + expense.index, 'entity')
            this.decisionString += this._formatTriplet('ont', 'has_organization_sponsor', 'OrganizationSponsor/1', 'entity', true, true)
            // Sponsored
            this.decisionString += '<Sponsored/' + expense.index + '> a ont:Sponsored;\n'
            this.decisionString += this._formatTriplet('ont', 'afm', expense.afm, 'string', false)
            this.decisionString += this._formatTriplet('ont', 'afm_type', expense.afm_type, 'string')
            this.decisionString += this._formatTriplet('ont', 'name', expense.sponsored, 'string', true, true)
          }
        })
        // OrganizationSponsor
        this.decisionString += '<OrganizationSponsor/1> a ont:OrganizationSponsor;\n'
        this.decisionString += this._formatTriplet('ont', 'afm_type', this.fields.sponsor_afm_type, 'string')
        afm = this.fields.sponsor_afm
        if (afm) {
          // Organization without afm
          this.decisionString += this._formatTriplet('ont', 'afm', this.fields.sponsor_afm, 'string', false)
        }
        this.decisionString += this._formatTriplet('ont', 'name', this.fields.sponsor_name, 'string', true, true)
        break
      case 'GeneralSpecialSecretaryMonocraticBody':
        if (this.fields.expense_amount && this.fields.expense_currency) {
          this.decisionString += '<Expense/1> a ont:Expense;\n'
          this.decisionString += this._formatTriplet('ont', 'expense_amount', this.fields.expense_amount, 'string')
          this.decisionString += this._formatTriplet('ont', 'expense_amount_currency', this.fields.expense_currency, 'string', true, true)
        }
        break
      case 'OwnershipTransferOfAssets':
        let sponsorFieldsSet = this.fields.sponsor_afm && this.fields.sponsor_name && this.fields.sponsor_afm_type
        let atLeastOneSponsored = this.fields.expense[0].afm && this.fields.expense[0].afm_type && this.fields.expense[0].index
        if (sponsorFieldsSet && atLeastOneSponsored && this.fields.asset_name) {
          this.decisionString += '<Expense/1> a ont:Expense;\n'
          this.fields.expense.forEach((expense, i) => {
            if (expense.afm && expense.afm_type && expense.sponsored) {
              this.decisionString += this._formatTriplet('ont', 'has_sponsored', 'Sponsored/' + (i + 1), 'entity')
            }
          })
          this.decisionString += this._formatTriplet('ont', 'has_organization_sponsor', 'OrganizationSponsor/1', 'entity', true, true)
          // OrganizationSponsor
          this.decisionString += '<OrganizationSponsor/1> a ont:OrganizationSponsor;\n'
          this.decisionString += this._formatTriplet('ont', 'afm_type', this.fields.sponsor_afm_type, 'string')
          afm = this.fields.sponsor_afm
          if (afm) {
            // Organization without afm
            this.decisionString += this._formatTriplet('ont', 'afm', this.fields.sponsor_afm, 'string', false)
          }
          this.decisionString += this._formatTriplet('ont', 'name', this.fields.sponsor_name, 'string', true, true)
          // Sponsored
          this.fields.expense.forEach((expense) => {
            if (expense.afm && expense.afm_type && expense.sponsored) {
              this.decisionString += '<Sponsored/' + expense.index + '> a ont:Sponsored;\n'
              this.decisionString += this._formatTriplet('ont', 'afm', expense.afm, 'string', false)
              this.decisionString += this._formatTriplet('ont', 'afm_type', expense.afm_type, 'string')
              this.decisionString += this._formatTriplet('ont', 'name', expense.sponsored, 'string', true, true)
            }
          })
        }
        break
      case 'Undertaking':
        this.fields.expense.forEach((expense, i) => {
          if (expense.kae && expense.expense_amount && expense.expense_currency && expense.kae_budget_remainder && expense.kae_credit_remainder && expense.index) {
            this.decisionString += '<ExpenseWithKae/' + expense.index + '> a ont:ExpenseWithKae;\n'
            this.decisionString += this._formatTriplet('ont', 'expense_amount', expense.expense_amount, 'string', false)
            this.decisionString += this._formatTriplet('ont', 'expense_amount_currency', expense.expense_currency, 'string')
            this.decisionString += this._formatTriplet('ont', 'kae', expense.kae, 'string', false)
            this.decisionString += this._formatTriplet('ont', 'kae_budget_remainder', expense.kae_budget_remainder, 'string', false)
            if (expense.afm && expense.afm_type && expense.sponsored) {
              this.decisionString += this._formatTriplet('ont', 'has_sponsored', 'Sponsored/' + (i + 1), 'entity')
            }
            this.decisionString += this._formatTriplet('ont', 'kae_credit_remainder', expense.kae_credit_remainder, 'string', false, true)
          }
          if (expense.afm && expense.afm_type && expense.sponsored) {
            this.decisionString += '<Sponsored/' + (i + 1) + '> a ont:Sponsored;\n'
            this.decisionString += this._formatTriplet('ont', 'afm', expense.afm, 'string', false)
            this.decisionString += this._formatTriplet('ont', 'afm_type', expense.afm_type, 'string')
            this.decisionString += this._formatTriplet('ont', 'name', expense.sponsored, 'string', true, true)
          }
        })
        break
      case 'WorkAssignmentSupplyServicesStudies':
        if (this.fields.expense[0].afm && this.fields.expense[0].sponsored && this.fields.expense[0].index && this.fields.expense[0].afm_type && this.fields.expense_amount && this.fields.expense_currency) {
          this.decisionString += '<Expense/1> a ont:Expense;\n'
          // All expenses have the same CPV
          if (this.fields.cpv) {
            this.decisionString += this._formatTriplet('ont', 'cpv', this.fields.cpv, 'string', false)
          }
          this.fields.expense.forEach((expense, i) => {
            if (expense.afm && expense.sponsored && expense.index && expense.afm_type) {
              this.decisionString += this._formatTriplet('ont', 'has_sponsored', 'Sponsored/' + (i + 1), 'entity')
            }
          })
          this.decisionString += this._formatTriplet('ont', 'expense_amount', this.fields.expense_amount, 'string', false)
          this.decisionString += this._formatTriplet('ont', 'expense_amount_currency', this.fields.expense_currency, 'string', true, true)
          this.fields.expense.forEach((expense, i) => {
            if (expense.afm && expense.sponsored && expense.index && expense.afm_type) {
              this.decisionString += '<Sponsored/' + expense.index + '> a ont:Sponsored;\n'
              this.decisionString += this._formatTriplet('ont', 'afm', expense.afm, 'string', false)
              this.decisionString += this._formatTriplet('ont', 'afm_type', expense.afm_type, 'string')
              this.decisionString += this._formatTriplet('ont', 'name', expense.sponsored, 'string', true, true)
            }
          })
        }
        break
      case 'PaymentFinalisation':
        if (this.fields.organizationSponsorAfm && this.fields.organizationSponsorAfmType && this.fields.organizationSponsorName) {
          var atLeastOneValidExpense = false
          var withHoldingMap = {}
          var withKaeSubExpenseMap = {}
          var lastwithHolding = 1
          var lastWithKaeSubExpense = 1
          this.fields.expense.forEach((expense, i) => {
            if (((expense.afm && expense.afm_type && expense.name) || this.fields.reason_multiple_afm_ignorance) && expense.expense_amount && expense.expense_currency) {
              this.decisionString += '<Expense/' + (i + 1) + '> a ont:Expense;\n'
              this.decisionString += this._formatTriplet('ont', 'expense_amount', expense.expense_amount, 'string', false)
              this.decisionString += this._formatTriplet('ont', 'expense_amount_currency', expense.expense_currency, 'string', true)
              if (expense.payment_reason) {
                this.decisionString += this._formatTriplet('ont', 'payment_reason', expense.payment_reason, 'string', true)
              }
              if (expense.cpv) {
                this.decisionString += this._formatTriplet('ont', 'cpv', expense.cpv, 'string', false)
              }
              if (expense.payment_with_withholdings && expense.payment_with_withholdings_currency) {
                this.decisionString += this._formatTriplet('ont', 'payment_with_withholdings', expense.payment_with_withholdings, 'string', false)
                this.decisionString += this._formatTriplet('ont', 'payment_with_withholdings_currency', expense.payment_with_withholdings_currency, 'string', true)
              }
              if (expense.document) {
                expense.document.forEach(doc => {
                  this.decisionString += this._formatTriplet('ont', 'has_document', doc, 'string', true)
                })
              }
              if (expense.withholding) {
                expense.withholding.forEach(withholding => {
                  if (withholding.withholding_text && withholding.withholding_expense && withholding.withholding_expense_currency) {
                    this.decisionString += this._formatTriplet('ont', 'has_withHolding', 'WithHolding/' + lastwithHolding, 'entity', false)
                    withHoldingMap[lastwithHolding] = withholding
                    lastwithHolding++
                  }
                })
              }
              if (expense.withKaeSubExpense) {
                expense.withKaeSubExpense.forEach(subexpense => {
                  if (subexpense.kae && subexpense.expense_amount && subexpense.expense_amount_currency) {
                    this.decisionString += this._formatTriplet('ont', 'has_withkaesubexpense', 'WithKaeSubExpense/' + lastWithKaeSubExpense, 'entity', false)
                    withKaeSubExpenseMap[lastWithKaeSubExpense] = subexpense
                    lastWithKaeSubExpense++
                  }
                })
              }
              this.decisionString += this._formatTriplet('ont', 'has_organization_sponsor', 'OrganizationSponsor/1', 'entity', false, true)
              if (!this.fields.reason_multiple_afm_ignorance) {
                this.decisionString += '<Sponsored/' + (i + 1) + '> a ont:Sponsored;\n'
                this.decisionString += this._formatTriplet('ont', 'name', expense.name, 'string', true)
                this.decisionString += this._formatTriplet('ont', 'afm', expense.afm, 'string', false)
                this.decisionString += this._formatTriplet('ont', 'afm_type', expense.afm_type, 'string', true, true)
              }
              atLeastOneValidExpense = true
            }
          })
          if (atLeastOneValidExpense) {
            this.decisionString += '<OrganizationSponsor/1> a ont:OrganizationSponsor;\n'
            this.decisionString += this._formatTriplet('ont', 'afm', this.fields.organizationSponsorAfm, 'string')
            this.decisionString += this._formatTriplet('ont', 'afm_type', this.fields.organizationSponsorAfmType, 'string')
            this.decisionString += this._formatTriplet('ont', 'name', this.fields.organizationSponsorName, 'string', true, true)

            for (let key in withHoldingMap) {
              let withholding = withHoldingMap[key]
              this.decisionString += '<WithHolding/' + key + '> a ont:WithHolding;\n'
              this.decisionString += this._formatTriplet('ont', 'withholding_text', withholding.withholding_text, 'string', true)
              this.decisionString += this._formatTriplet('ont', 'withholding_expense', withholding.withholding_expense, 'string', false)
              this.decisionString += this._formatTriplet('ont', 'withholding_expense_currency', withholding.withholding_expense_currency, 'string', true, true)
            }

            for (let key in withKaeSubExpenseMap) {
              let subexpense = withKaeSubExpenseMap[key]
              this.decisionString += '<WithKaeSubExpense/' + key + '> a ont:WithKaeSubExpense;\n'
              this.decisionString += this._formatTriplet('ont', 'kae', subexpense.kae, 'string', false)
              this.decisionString += this._formatTriplet('ont', 'expense_amount', subexpense.expense_amount, 'string', false)
              this.decisionString += this._formatTriplet('ont', 'expense_amount_currency', subexpense.expense_amount_currency, 'string', true, true)
            }
          }
        }
        break
    }
  }

  _getN3DecisionsLocation () {
    let storageDir = expandHomeDir(config.get('decisionsSaveDir'))
    return co(function * () {
      let exists = fs.exists(storageDir)
      if (!exists) {
        yield fs.mkdir(storageDir)
      }
      return storageDir
    })
  }

  generateN3 () {
    this._writePrefixes()
    this._writeGeneralInfo()
    this._writeDecisionBody()
    if (!this.benchmark) {
      this._writeRestEntities()
    }

    var _this = this
    return co(function * () {
      var collection = db.collection('decisions')
      // we do not use co-monk here to achieve higher throughput
      collection.insert({iun: _this.fields.iun, version: _this.fields.version, title: _this.fields.title, date: new Date()})
      const storageDirectory = yield _this._getN3DecisionsLocation()
      let unzipedFilepath = storageDirectory + '/' + _this.fields.iun + '_' + _this.fields.version + '.n3'
      let gzipedFilepath = unzipedFilepath + '.gz'
      const outStream = stdfs.createWriteStream(gzipedFilepath)
      yield fs.writeFile(unzipedFilepath, _this.decisionString)
      const inp = stdfs.createReadStream(unzipedFilepath)
      const zlib = require('zlib')
      const gzip = zlib.createGzip()
      inp.pipe(gzip).pipe(outStream)
      const resolvedPath = path.resolve(config.get('SOH_post_executable'))
      var output
      if (!_this.benchmark) {
        // Blockchain benchmark is unrelated to rdf store insertion, so ignore it
        output = yield spawn(resolvedPath, [config.get('sparqlEndpointUrl') + '/' + config.get('dataset'), 'default', unzipedFilepath])
      } else {
        output = undefined
      }
      return {output, outStream, unzipedFilepath}
    }).then((retObj) => {
      retObj.outStream.on('finish', () => {
        fs.unlink(retObj.unzipedFilepath)
      })
      if (!retObj.output) {
        return true
      } else {
        return retObj.output
      }
    })
  }
}

module.exports = Decision
