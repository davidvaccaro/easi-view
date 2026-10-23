import {createDicomFixture} from '../../src/data/synthetic.js';

/** Independent public qualification inputs. Every byte is generated, including
 * pixels, identifiers, dates and descriptions; no local imaging is read. */
export function createAiConceptStudyFiles({includePrior = false} = {}) {
    const root = '2.25.2026102201';
    const floating = value => {const bytes = new Uint8Array(8);new DataView(bytes.buffer).setFloat64(0,value,true);return bytes;};
    const studies = [{id:1,date:'20260303',prefix:300,title:'SYNTHETIC CURRENT CT'},
        ...(includePrior?[{id:2,date:'20251220',prefix:400,title:'SYNTHETIC PRIOR CT'}]:[])];
    return studies.flatMap(study => {
        const number = suffix => study.prefix + suffix;
        const series = [
            {number:number(1),title:'AXIAL SCOUT',imageType:['ORIGINAL','PRIMARY','LOCALIZER'],frames:2},
            {number:number(12),title:'70 keV Stnd',energy:70},
            {number:number(13),title:'50 keV Stnd',energy:50},
            {number:number(17),title:'Blended Stnd',imageType:['ORIGINAL','PRIMARY','AXIAL','BLENDED']},
            {number:number(16),title:'Virtual unenhanced axial',imageType:['ORIGINAL','SECONDARY','AXIAL','GSI','VUE']},
            {number:number(18),title:'MIP axial projection',imageType:['DERIVED','SECONDARY','AXIAL','MIP']},
            {number:number(20),title:'Material density axial map',imageType:['ORIGINAL','SECONDARY','AXIAL','GSI','MD'],unit:'MG/ML'}
        ];
        return series.flatMap(item => Array.from({length:item.frames??5},(_,index) => {
            const uid = `${root}.${study.id}.${item.number}`;
            return new File([createDicomFixture({modality:'CT',seriesUid:uid,sopUid:`${uid}.${index+1}`,instanceNumber:index+1,
                description:item.title,position:[0,0,index*1.25],signed:true,rescaleType:item.unit??'HU',
                values:[-900+index*10,-100+index*10,40+index*10,1100+index*10],extraAttributes:{
                    '00080008':['CS',item.imageType??['ORIGINAL','PRIMARY','AXIAL']],
                    '00080020':['DA',study.date],'00081030':['LO',study.title],
                    '00100010':['PN','SYNTHETIC^CONCEPT'],'00100020':['LO','SYNTHETIC-CONCEPT'],
                    '00100021':['LO','EASI GENERATED CONCEPT'],'00180015':['CS','CHEST'],
                    '00180050':['DS','1.25'],'00181210':['SH','STANDARD'],
                    '0018937C':item.energy?['FD',floating(item.energy)]:null,
                    '0020000D':['UI',`${root}.${study.id}`],'00200011':['IS',item.number],
                    '00200052':['UI',`${root}.${study.id}.99999`]
                }})],`GENERATED-CONCEPT-${study.id}-${item.number}-${index+1}`,{type:'application/dicom'});
        }));
    });
}
