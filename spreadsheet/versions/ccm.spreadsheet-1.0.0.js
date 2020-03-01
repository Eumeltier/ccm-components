(function () {
    let component = {
        name: "spreadsheet",
        version: [1,0,0],
        
        ccm: "https://ccmjs.github.io/ccm/versions/ccm-20.0.0.js",
        
        config: {
            css: ["ccm.load", { url: "http://www2.inf.h-brs.de/~alysek2s/spreadsheet/resources/css/spreadsheet.css", type: "css" }],
			mathjs: ["ccm.load", { url: "https://unpkg.com/mathjs@6.3.0/dist/math.min.js", type: "js"}],
            rxCore: ["ccm.load", { url: "https://dev.jspm.io/rxjs@6/_esm2015/index", type: "module" }],
            rxOps: ["ccm.load", { url: "https://dev.jspm.io/rxjs@6/_esm2015/operators", type: "module" }]
        },
        
        Instance: function () {
            const self = this;
            this.init = async () => {
                console.log(math);
                console.log(this.rxCore);
                console.log(this.rxOps);
            };

            this.start = async () => {
                const spreadsheetController = new SpreadsheetController(self, this.element);
            };
        }
    };

    const delimiter = '|';
    const rangeOperator = ':';

    const cellKeyRegex = /([A-Za-z]+)([0-9]+)/;

    const getColumnIdFromIndex = function(index) {
        if(index === 0) return '0';
        let rest, columnId = '';
        while(index > 0) {
            rest = (index - 1) % 26;
            columnId = String.fromCharCode(65 + rest) + columnId;
            index = (index - rest - 1) / 26;
        }
        return columnId;
    };

    const getIndexFromColumnId = function(columnId) {
        return Array.from(columnId).reduce( (index, char, pos, array) => { return index + ((char.charCodeAt(0) - 64) * Math.pow(26, array.length - pos - 1)); }, 0 );
    };

    const getCoordObjectFromKey = function(key) {
        const keyPairs = key.split(delimiter);
        return { x: parseInt(keyPairs[0]), y: parseInt(keyPairs[1]) };
    };

    const compareCellId = function(cellA, cellB) {
        if(cellA.coords.x < cellB.coords.x || cellA.coords.y < cellB.coords.y) {
            return -1;//A < B
        } else if(cellA.coords.x > cellB.coords.x || cellA.coords.y > cellB.coords.y) {
            return 1;//A > B
        } else {
            return 0;//A = B
        }
    };

    const cellIdToCellCoords = function(cellId) {
        const groups = cellId.match(cellKeyRegex);
        const x = getIndexFromColumnId(groups[1]);
        const y = parseInt(groups[2]);
        return {x: x, y: y};
    };

    const sum = function(cells) {
        return '=' + cells.map( cell => cell.id).join('+');            
    };

    const product = function(cells) {
        return '=' + cells.map( cell => cell.id).join('*');
    };

    const average = function(cells) {
        return '=(' + cells.map( cell => cell.id).join('+') + ')/' + cells.length;
    };

    class SpreadsheetController {
        constructor(self, htmlRootElement) {
            this.self = self;
            this.rxCore = self.rxCore;
            this.rxOps = self.rxOps;
            this.cellStorage = new CellStorage(this);

            this.rootEle = htmlRootElement;
            this.maxRowCount = 100 + 1;
            this.maxColumnCount = 50 + 1;
            this.cellRangeSelectionController = new CellRangeSelectionController(this);
            this.formulaController = new FormulaController(this);
            this.spreadsheetView = new SpreadsheetView(this, htmlRootElement);

            this.formulaSubject = new this.rxCore.Subject();
            this.actionSubject = new this.rxCore.Subject();
            //this.navigationObservable = new this.rxCore.Observable();
            this.evaluationSubject = new this.rxCore.Subject();

            this.formulaController.initialize();
            this.cellRangeSelectionController.initialize(this.cellStorage.getCells({start: 'A1', end: 'A1'})[0]);
            
            this.initializeActionSubject();
            this.initializeEvaluationSubject();
        }

        initializeActionSubject() {
            const sumStream = this.rxCore.fromEvent(this.spreadsheetView.getSumBtnDiv(), 'click').pipe(
                this.rxOps.map(clickEvent => sum)
            );

            const productStream = this.rxCore.fromEvent(this.spreadsheetView.getProductBtnDiv(), 'click').pipe(
                this.rxOps.map(clickEvent => product)
            );
            
            const averageStream = this.rxCore.fromEvent(this.spreadsheetView.getAverageBtnDiv(), 'click').pipe(
                this.rxOps.map(clickEvent => average)
            );

            const actionStream = this.rxCore.merge(sumStream, productStream, averageStream);
            
            const actionAndTargetStream = this.actionSubject.pipe(
                this.rxOps.observeOn(this.rxCore.asyncScheduler),
                this.rxOps.withLatestFrom(this.cellRangeSelectionController.selectionSubject),
                this.rxOps.map( array => { array.push(this.getResultCell(array[1])); return array; }),
                this.rxOps.filter(array => array.length > 2 && array[2] !== undefined && array[2] !== null),
                this.rxOps.map( array => {
                    const callback = array[0];
                    const cells = array[1];
                    const resultCell = array[2];
                    const inputString = callback(cells);
                    resultCell.handleInput({input: inputString});
                    return resultCell;
                })
            );
            actionStream.subscribe(actionAndTargetStream);

            actionAndTargetStream.subscribe({
                next: cell => this.evaluationSubject.next(cell),
                error: () => console.log('Error in actionAndTarget Stream')
            });
            
        }

        getResultCell(cells) {
            if(cells.length > 1) {
                return this.cellStorage.getResultCell(cells[0], cells[cells.length-1]);
            } else {
                return this.cellStorage.getResultCell(cells[cells.length-1]);
            }
        }

        initializeEvaluationSubject() {
            this.evaluationSubject.pipe(
                this.rxOps.filter(cell => cell.isFormula && !cell.isError),
                this.rxOps.observeOn(this.rxCore.asyncScheduler)
            ).subscribe({
                next: cell => cell.evaluate(),
                error: () => console.log(`Error in evaluation observer!`)
            });
        }

    }

    class CellRangeSelectionController {
        constructor(spreadsheetController) {
            this.controller = spreadsheetController;
            this.rxCore = this.controller.rxCore;
            this.rxOps = this.controller.rxOps;
            this.selectionSubject = null;
            this.cellRangeDiv = null;
            this.cellStart = null;
            this.cellEnd = null;
            this.initializeSelectionSubject();
        }

        initializeSelectionSubject() {
            this.selectionSubject = new this.rxCore.Subject().pipe(
                this.rxOps.map( range => {
                    return this.controller.cellStorage.getCells(range);
                })
            );
        }

        initialize(initiallySelectedCell) {
            this.cellRangeDiv = this.controller.spreadsheetView.getSelectedCellRangeDiv();
            this.handleInput({shiftKey: false}, initiallySelectedCell);
        }

        handleInput(clickEvent, targetCell) {
            if(clickEvent.shiftKey) {
                this.cellEnd = targetCell;
            } else {
                this.cellStart = targetCell;
                this.cellEnd = null;
            }
            if(this.cellEnd !== null) {
                if(compareCellId(this.cellStart, this.cellEnd) === 0) {
                    this.cellEnd = null;
                } else if(compareCellId(this.cellStart, this.cellEnd) === 1) {
                    const cellTmp = this.cellEnd;
                    this.cellEnd = this.cellStart;
                    this.cellStart = cellTmp;
                }
            }
            this.handleOutput();
        }

        handleOutput() {
            if(this.cellEnd === null) {
                this.cellRangeDiv.innerText = this.cellStart.id;
                this.selectionSubject.next({start: this.cellStart.id, end: this.cellStart.id});
            } else {
                this.cellRangeDiv.innerText = this.cellStart.id + rangeOperator + this.cellEnd.id;
                this.selectionSubject.next({start: this.cellStart.id, end: this.cellEnd.id});
            }
        }
    }

    class FormulaController {
        constructor(spreadsheetController) {
            this.controller = spreadsheetController;
            this.rxCore = this.controller.rxCore;
            this.rxOps = this.controller.rxOps;
            this.formulaDiv = null;
            this.selectedCell = null;
        }

        initialize() {
            this.formulaDiv = this.controller.spreadsheetView.getFormulaDiv();
            this.controller.cellRangeSelectionController.selectionSubject.subscribe({
                next: selection => {
                    this.selectedCell = selection[0];
                    this.formulaDiv.innerText = this.selectedCell.getFormulaOutput();
                },
                error: () => console.log(`Error in CellRangeSelectionQueue`)
            });
            this.setupEvaluationTrigger();
            this.setupInputHandler();
        }

        setupEvaluationTrigger() {
            const enterKeydownEvent = this.rxCore.fromEvent(this.formulaDiv, 'keydown').pipe(
                this.rxOps.filter(event => event.keyCode === 13),
                this.rxOps.tap(event => event.preventDefault())
            );

            const deselectEvent = this.rxCore.fromEvent(this.formulaDiv, 'blur');
            const evaluationTriggerEvents = this.rxCore.merge(enterKeydownEvent, deselectEvent).pipe(
                this.rxOps.debounce( () => this.rxCore.timer(50) )
            );

            const evaluationSubscription = evaluationTriggerEvents.subscribe({
                next: (event) => {
                    if(this.selectedCell !== null && this.selectedCell.isFormula) 
                        this.controller.evaluationSubject.next(this.selectedCell);
                },
                error: () => console.log(`Error in FormulaEvaluationTrigger`)
            });
        }

        setupInputHandler() {
            this.rxCore.fromEvent(this.formulaDiv, 'input').subscribe( 
                event => {
                    if(this.selectedCell !== null)
                        this.selectedCell.inputSubject.next({target: this.formulaDiv, event: event});
                }
            );
        }

        setFormulaText(text) {
            this.formulaDiv.innerText = text;
        }

    }

    class SpreadsheetView {
        constructor(spreadsheetController, htmlRootElement) {
            this.controller = spreadsheetController;
            this.rxCore = this.controller.rxCore;
            this.rxOps = this.controller.rxOps;           
            this.rootEle = htmlRootElement;
            this.tableDiv = null;
            this.selectedCellRangeDiv = null;
            this.formulaDiv = null;
            this.sumBtnDiv = null;
            this.productBtnDiv = null;
            this.averageBtnDiv = null;
            this.createControlBar();
            this.createSpreadsheet();
        }

        getSelectedCellRangeDiv() {
            return this.selectedCellRangeDiv;
        }

        getFormulaDiv() {
            return this.formulaDiv;
        }

        getSumBtnDiv() {
            return this.sumBtnDiv;
        }

        getProductBtnDiv() {
            return this.productBtnDiv;
        }

        getAverageBtnDiv() {
            return this.averageBtnDiv;
        }

        createControlBar() {
            const controlBarContainerDiv = document.createElement('div');
            controlBarContainerDiv.className = "controlBarContainer";
            const actionBarContainerDiv = this.createActionBar();
            controlBarContainerDiv.appendChild(actionBarContainerDiv);
            const formulaBarContainerDiv = this.createFormulaBar();
            controlBarContainerDiv.appendChild(formulaBarContainerDiv);
            
            this.rootEle.appendChild(controlBarContainerDiv);
        }

        createActionBar() {
            const actionBarDiv = document.createElement('div');
            actionBarDiv.className = "barContainer";
            this.sumBtnDiv = this.createActionButton('Summe');
            this.productBtnDiv = this.createActionButton('Produkt');
            this.averageBtnDiv = this.createActionButton('Mittelwert');
            actionBarDiv.appendChild(this.sumBtnDiv);
            actionBarDiv.appendChild(this.productBtnDiv);
            actionBarDiv.appendChild(this.averageBtnDiv);
            return actionBarDiv;
        }

        createActionButton(actionName) {
            const actionButton = document.createElement('div');
            actionButton.className = "content static action";
            actionButton.innerText = actionName;
            return actionButton;
        }

        createFormulaBar() {
            const formulaBarDiv = document.createElement('div');
            formulaBarDiv.className = "barContainer";
            
            this.selectedCellRangeDiv = document.createElement('div');
            this.selectedCellRangeDiv.id = "selectedCellRange";
            this.selectedCellRangeDiv.className = "content static";
            this.selectedCellRangeDiv.innerText = 'A1';
            
            const functionSignDiv = document.createElement('div');
            functionSignDiv.id = "formulaSign";
            functionSignDiv.className = "content static";
            functionSignDiv.style.fontStyle = "oblique";
            functionSignDiv.style.color = "grey";
            functionSignDiv.innerText = "fx";
            
            this.formulaDiv = document.createElement('div');
            this.formulaDiv.id = "formula";
            this.formulaDiv.className = "content dynamic";
            this.formulaDiv.contentEditable = true;

            formulaBarDiv.appendChild(this.selectedCellRangeDiv);
            formulaBarDiv.appendChild(functionSignDiv);
            formulaBarDiv.appendChild(this.formulaDiv);
            return formulaBarDiv;
        }

        createSpreadsheet() {
            const tableContainerDiv = document.createElement('div');
            tableContainerDiv.id = "tableContainer";

            this.rxCore.range(0, this.controller.maxRowCount).pipe(
                this.rxOps.map( rowIndex => {
                    let tmpRowDiv = null;
                    this.rxCore.range(0, this.controller.maxColumnCount).pipe(
                        this.rxOps.map( columnIndex => {
                            return this.createCellDiv(columnIndex, rowIndex);
                        }),
                        this.rxOps.reduce( (tableRowDiv, cellDiv) => {
                            tableRowDiv.appendChild(cellDiv);
                            return tableRowDiv;
                        }, this.createTableRowDiv())
                    ).subscribe( value => { tmpRowDiv = value; });
                    return tmpRowDiv;
                }),
                this.rxOps.reduce( (tableDiv, tableRowDiv) => {
                    tableDiv.appendChild(tableRowDiv);
                    return tableDiv;
                }, this.createTableDiv())
            ).subscribe(value => { this.tableDiv = value; });

            const cellDivs = Array.from(this.tableDiv.childNodes).reduce( (flat, row) => {
                return flat.concat(...row.childNodes);
            }, [] );

            cellDivs.filter(this.isDataCell).map( dataCell => {
                dataCell.contentEditable = true;
                this.controller.cellStorage.createCell(dataCell.getAttribute('key'), dataCell);
            });

            cellDivs.filter(this.isRowIndexCellDiv).map( rowIndexCell => {
                rowIndexCell.innerText = rowIndexCell.getAttribute('key').split(delimiter)[1];
                rowIndexCell.style = "resize: vertical;";
                rowIndexCell.className += " indexCell";
            });

            cellDivs.filter(this.isColumnIndexCellDiv).map( columnIndexCell => {
                columnIndexCell.innerText = getColumnIdFromIndex(
                    parseInt(
                        columnIndexCell.getAttribute('key').split(delimiter)[0]
                    )
                );
                columnIndexCell.style = "resize: horizontal;";
                columnIndexCell.className += " indexCell";
            });

            const topLeftCellDiv = this.tableDiv.firstChild.firstChild;
            topLeftCellDiv.innerText = "";
            topLeftCellDiv.style = "";
            topLeftCellDiv.style.backgroundColor = "grey";

            tableContainerDiv.appendChild(this.tableDiv);
            this.rootEle.appendChild(tableContainerDiv);
        }

        isDataCell(cellDiv) {
            const keyValueArray = cellDiv.getAttribute('key').split(delimiter);
            return parseInt(keyValueArray[0]) > 0 && parseInt(keyValueArray[1]) > 0;
        }

        isRowIndexCellDiv(cellDiv) {
            return cellDiv.getAttribute('key').split(delimiter)[0] === '0';
        }

        isColumnIndexCellDiv(cellDiv) {
            return cellDiv.getAttribute('key').split(delimiter)[1] === '0';
        }

        createCellDiv(columnIndex, rowIndex) {
            const cellDiv = document.createElement('div');
            cellDiv.className = 'TableCell';
            const cellKey = columnIndex + delimiter + rowIndex;
            cellDiv.setAttribute('key', cellKey);
            return cellDiv;
        }

        createTableRowDiv() {
            const tableRowDiv = document.createElement('div');
            tableRowDiv.className = 'TableRow';
            return tableRowDiv;
        }

        createTableDiv() {
            const tableDiv = document.createElement('div');
            tableDiv.className = 'Table';
            return tableDiv;
        }

    }

    class CellStorage {
        constructor(controller) {
            this.controller = controller;
            this.cells = {};
        }

        createCell(key, div) {
            return this.cells[key] = new Cell(this.controller, key, div);
        }

        getCells(range) {
            if(range.start === range.end) {
                const cellCoords = cellIdToCellCoords(range.start);
                return [this.cells[cellCoords.x + delimiter + cellCoords.y]];
            } else {
                const startCoords = cellIdToCellCoords(range.start);
                const endCoords = cellIdToCellCoords(range.end);
                if(startCoords.y > endCoords.y) {
                    const yTmp = startCoords.y;
                    startCoords.y = endCoords.y;
                    endCoords.y = yTmp;
                }
                if(startCoords.x > endCoords.x) {
                    const xTmp = startCoords.x;
                    startCoords.x = endCoords.x;
                    endCoords.x = xTmp;
                }
                return Object.values(this.cells).filter((cell) => {
                    return  cell.coords.x >= startCoords.x && 
                            cell.coords.y >= startCoords.y && 
                            cell.coords.x <= endCoords.x && 
                            cell.coords.y <= endCoords.y;
                });
            }
        }

        getResultCell(startCell, endCell) {     
            if(endCell !== undefined && endCell !== null) {
                let offsetX = 0;
                let offsetY = 0;
                if(endCell.coords.y === startCell.coords.y) {
                    offsetX += 1;
                } else {
                    offsetY += 1;
                }
                const columnLetter = getColumnIdFromIndex(endCell.coords.x + offsetX);
                const rowNumber = endCell.coords.y + offsetY;
                return this.getCells({start: columnLetter + rowNumber, end: columnLetter + rowNumber})[0];
            } else {
                const columnLetter = getColumnIdFromIndex(startCell.coords.x);
                const rowNumber = startCell.coords.y + 1;
                return this.getCells({start: columnLetter + rowNumber, end: columnLetter + rowNumber})[0];
            }
        }

    }

    class Cell {
        cellRegex = /([A-Z|a-z]+[0-9]+)/mg;
        cellKeyRegex = /([A-Za-z]+)([0-9]+)/mg;
        newlineRegex = /[\r\n]+/g;

        constructor(controller, key, tableCellDiv) {
            this.controller = controller;
            this.rxCore = controller.rxCore;
            this.rxOps = controller.rxOps;
            this.coords = getCoordObjectFromKey(key);
            this.id = "" + getColumnIdFromIndex(this.coords.x) + this.coords.y;
            this.subMgr = new SubscriptionManager(this);
            this.tableCellDiv = tableCellDiv;
            this.value = "";
            this.formula = "";
            this.error = "";
            this.isFormula = false;
            this.isError = false;
            this.inputSubject = new this.rxCore.Subject();
            this.cellSubject = new this.rxCore.Subject();

            this.setupEvaluationTrigger();
            this.setupOnclickHandler();
            this.setupInputSubject();
            this.setupInputHandler();
        }

        setupOnclickHandler() {
            this.rxCore.fromEvent(this.tableCellDiv, 'click').subscribe(
                event => this.controller.cellRangeSelectionController.handleInput(event, this)
            );
        }

        setupEvaluationTrigger() {
            const enterKeydownEvent = this.rxCore.fromEvent(this.tableCellDiv, 'keydown').pipe(
                this.rxOps.filter(event => event.keyCode === 13 && event.shiftKey === false),
                this.rxOps.tap(event => event.preventDefault())
            );
            const deselectEvent = this.rxCore.fromEvent(this.tableCellDiv, 'blur');
            const evaluationTriggerEvents = this.rxCore.merge(enterKeydownEvent, deselectEvent).pipe(
                this.rxOps.debounce( () => this.rxCore.timer(50) )
            );
            const evaluationSubscription = evaluationTriggerEvents.subscribe({
                next: (event) => {
                        this.controller.evaluationSubject.next(this);
                },
                error: () => console.log(`Error in EvaluationTrigger(${this.id})`)
            });
        }

        setupInputHandler() {
            this.rxCore.fromEvent(this.tableCellDiv, 'input').subscribe(
                event => this.inputSubject.next({ src: this.tableCellDiv, event: event })
            );
        }

        setupInputSubject() {
            const inputSubjectDebounce = this.inputSubject.pipe(
                this.rxOps.debounce( () => this.rxCore.timer(100) ),
                this.rxOps.map(this.prepareInput)
            );

            const cellDivInput = inputSubjectDebounce.pipe(
                this.rxOps.filter( (object) => object.src === this.tableCellDiv )
            );
            cellDivInput.subscribe({
                next: (object) => {
                    this.handleInput(object);
                    this.controller.formulaController.setFormulaText(this.getFormulaOutput());
                },
                error: () => console.log(`Error in InputSubject(${this.id})`)
            });

            const formulaDivInput = inputSubjectDebounce.pipe(
                this.rxOps.filter( (object) => object.src !== this.tableCellDiv )
            );
            formulaDivInput.subscribe({
                next: (object) => {
                    this.handleInput(object);
                    this.tableCellDiv.innerText = this.getFormulaOutput();
                },
                error: () => console.log(`Error in InputSubject(${this.id})`)
            });
        }

        prepareInput(object) {
            const input = object.event.path[0].innerText.replace(this.newlineRegex,'');
            return { src: object.src, input: input };
        }

        handleInput(object) {
            if(object.input.startsWith("=")) {
                this.formula = object.input.toUpperCase();
                this.isFormula = true;
                this.handleSubscriptions();
            } else {
                this.value = object.input;
                this.isFormula = false;
                this.notify();
            }    
        }

        handleSubscriptions() {
            this.subMgr.cancelAll();
            if(this.cellRegex.test(this.formula)) {
                this.formula.substring(1).match(this.cellRegex).some( cellId => {
                    const targetCell = this.controller.cellStorage.getCells({start: cellId, end: cellId})[0];
                    if(targetCell === undefined) {//in case of out of bounds
                        this.isError = true;
                        this.error = `OutOfBounds for ${cellId}`;
                        return this.isError;
                    }

                    const hasNoCycle = this.subMgr.hasNoDepWith(targetCell);
                    if(hasNoCycle) {
                        this.isError = false;
                        this.subMgr.subscribe(targetCell);
                    } else {
                        this.isError = true;
                        this.error = `Cycle between ${this.id} and ${targetCell.id}`;
                        console.log(`Error: Cycle detected between Cell(${this.id}) and Cell(${targetCell.id})`);
                    }
                    return this.isError;
                });
            }   
        }

        getFormulaOutput() {
            return this.isFormula ? this.formula.replace(this.newlineRegex,'') : ('' + this.value);
        }

        evaluate() {
            const evaluationString = this.formula.substring(1)
                .replace(this.newlineRegex,'')
                .replace(this.cellRegex, (cellId, $1) => {
                    return this.subMgr.getValue(cellId);
                }
            );
            let result = 0;    
            try {
                result = math.evaluate(evaluationString);
                result = result === undefined ? 0 : math.round(result, 3);
            } catch(error) {
                result = 0;
            }
            this.value = result;
            this.tableCellDiv.innerText = result;
            this.notify();
        }

        notify() {
            this.cellSubject.next(this);
        }

    }

    class SubscriptionManager {
        constructor(owner) {
            this.owner = owner;
            this.rxCore = owner.rxCore;
            this.rxOps = owner.rxOps;
            this.subs = {};
        }

        hasNoDepWith(cell) {
            if(cell.id === this.owner.id)
                return false;
            
            let noDep = false;
            this.getDependencies(cell).pipe(
                this.rxOps.find(value => value === this.owner.id)
            ).subscribe(value => value === undefined ? noDep = true : noDep = false);
            return noDep;
        }

        getDependencies(cell) {
            if(Object.entries(cell.subMgr.subs).length > 0) {
                let result = null;
                this.rxCore.from(Object.values(cell.subMgr.subs)).pipe(
                    this.rxOps.reduce( (acc, sub) => {
                        return acc.pipe(
                            this.rxOps.concat(this.rxCore.of(sub.cell.id), this.getDependencies(sub.cell))
                        );
                    }, this.rxCore.empty())
                ).subscribe(value => result = value);
                return result;
            } else /*(Object.entries(cell.subMgr.subs).length === 0) */{
                return this.rxCore.empty();
            }
        }

        subscribe(cell) {
            if(!(cell.id in this.subs)) {
                //console.log(`Cell(${this.owner.id}) subscribing to cell(${cell.id})`);
                const subscription = cell.cellSubject.subscribe({
                    next: (value) => { this.owner.controller.evaluationSubject.next(this.owner); },
                    error: () => console.log(`Error in SubscriptionManager of cell(${this.owner.id}) subscribed to cell(${cell.id})`)
                });
                this.subs[cell.id] = { cell: cell, sub: subscription };
            } else {
                console.log(`Warning: Tried duplicate subscription to cell(${cell.id})`);
            }
        }

        cancel(cell) {
            if(cell.id in this.subs) {
                const subscription = this.subs[cell.id].sub;
                subscription.unsubscribe();
                delete this.subs[cell.id];
            } else {
                console.log(`Error: Owner(${this.owner.id}) is not subscribed to cell(${cell.id})`);
            }
        }

        cancelAll() {
            Object.keys(this.subs).forEach( (id, value) => {
                //console.log(`Cell(${this.owner.id}) cancelling subscription to cell(${id})`);
                this.cancel(this.subs[id].cell);
            });
        }

        getValue(cellId) {
            if(cellId in this.subs) {
                return this.subs[cellId].cell.value;
            } else {
                console.log(`Error: Requesting value of Cell(${cellId}). No subscription to that cell!)`);
                return '0';
            }
        }

    }

//Magic ccm code line.
let b="ccm."+component.name+(component.version?"-"+component.version.join("."):"")+".js";if(window.ccm&&null===window.ccm.files[b])return window.ccm.files[b]=component;(b=window.ccm&&window.ccm.components[component.name])&&b.ccm&&(component.ccm=b.ccm);"string"===typeof component.ccm&&(component.ccm={url:component.ccm});let c=(component.ccm.url.match(/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/)||["latest"])[0];if(window.ccm&&window.ccm[c])window.ccm[c].component(component);else{var a=document.createElement("script");document.head.appendChild(a);component.ccm.integrity&&a.setAttribute("integrity",component.ccm.integrity);component.ccm.crossorigin&&a.setAttribute("crossorigin",component.ccm.crossorigin);a.onload=function(){window.ccm[c].component(component);document.head.removeChild(a)};a.src=component.ccm.url}
})();