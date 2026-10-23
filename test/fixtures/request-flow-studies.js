import {createDicomFixture} from '../../src/data/synthetic.js';
import {createDicomdirFixture} from '../dicomdir-fixtures.js';

/** Invented removable media for paged study selection and cancellable indexing.
 * Its pixels, identities, dates and files are authored independently here. */
export function createRequestFlowMedia({studies = 30, secondPatient = true, instancesPerStudy = 1, malformed = false} = {}) {
    if(!Number.isSafeInteger(studies)||studies<1||studies>100||!Number.isSafeInteger(instancesPerStudy)||instancesPerStudy<1||instancesPerStudy>20)throw new TypeError('Use bounded generated media.');
    const base='2.25.2026102202',files=[],records=[];
    for(const [patientIndex,studyCount]of[studies,...(secondPatient?[2]:[])].entries()){
        const patient=patientIndex+1,patientName=`SYNTHETIC^FLOW_${patient}`,patientId=`GENERATED-FLOW-${patient}`;
        const root={type:'PATIENT',patientName,patientId,attributes:{'00100021':['LO','EASI GENERATED FLOW']},children:[]};records.push(root);
        for(let study=1;study<=studyCount;study++){
            const date=new Date(Date.UTC(2026,2,32-study)).toISOString().slice(0,10).replaceAll('-','');
            const studyUid=`${base}.${patient}.${study}`,seriesUid=`${studyUid}.1`;
            const entry={type:'STUDY',studyUid,studyDate:date,studyDescription:`Generated patient ${patient} study ${String(study).padStart(2,'0')}`,children:[{type:'SERIES',seriesUid,modality:'CT',seriesNumber:1,children:[]}]};root.children.push(entry);
            for(let image=1;image<=instancesPerStudy;image++){
                const sopUid=`${seriesUid}.${image}`,fileId=[`PAT${String(patient).padStart(5,'0')}`,`ST${String(study).padStart(6,'0')}`,`IM${String(image).padStart(6,'0')}`];
                files.push({path:fileId.join('/'),bytes:createDicomFixture({modality:'CT',seriesUid,sopUid,instanceNumber:image,position:[0,0,(image-1)*2],description:'Generated axial source',values:[0,100,200,300],extraAttributes:{
                    '00080008':['CS',['ORIGINAL','PRIMARY','AXIAL']],'00080020':['DA',date],'00081030':['LO',entry.studyDescription],
                    '00100010':['PN',patientName],'00100020':['LO',patientId],'00100021':['LO','EASI GENERATED FLOW'],
                    '00180015':['CS','CHEST'],'0020000D':['UI',studyUid],'00200011':['IS',1],'00200052':['UI',`${studyUid}.99999`]
                }})});
                entry.children[0].children.push({type:'IMAGE',fileId,sopUid,instanceNumber:image});
            }
        }
    }
    files.unshift({path:'DICOMDIR',bytes:createDicomdirFixture(records,malformed?{firstRootOffset:1}:{})});
    return{files,expected:{patients:secondPatient?2:1,firstPatientStudies:studies,secondPatientStudies:secondPatient?2:0,images:(studies+(secondPatient?2:0))*instancesPerStudy}};
}
