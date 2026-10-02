package spacev1

// Semantic validation is mandatory; protobuf wire acceptance is insufficient.
// The imported CUE contract is applied before downstream execution.
#Units: {"UNITS_UNSPECIFIED", #enumValue: 0} |
	{"UNITS_MM", #enumValue: 1} |
	{"UNITS_CM", #enumValue: 2} |
	{"UNITS_M", #enumValue: 3}

#Units_value: {
	UNITS_UNSPECIFIED: 0
	UNITS_MM:          1
	UNITS_CM:          2
	UNITS_M:           3
}
#VoxelState: {"VOXEL_STATE_UNKNOWN", #enumValue: 0} |
	{"VOXEL_STATE_FREE", #enumValue: 1} |
	{"VOXEL_STATE_OCCUPIED", #enumValue: 2}

#VoxelState_value: {
	VOXEL_STATE_UNKNOWN:  0
	VOXEL_STATE_FREE:     1
	VOXEL_STATE_OCCUPIED: 2
}
#Provenance: {"PROVENANCE_UNSPECIFIED", #enumValue: 0} |
	{"PROVENANCE_MEASURED", #enumValue: 1} |
	{"PROVENANCE_RECONSTRUCTED_SCALE_UNCHECKED", #enumValue: 2} |
	{"PROVENANCE_GENERATED", #enumValue: 3}

#Provenance_value: {
	PROVENANCE_UNSPECIFIED:                   0
	PROVENANCE_MEASURED:                      1
	PROVENANCE_RECONSTRUCTED_SCALE_UNCHECKED: 2
	PROVENANCE_GENERATED:                     3
}
#EvidenceState: {"EVIDENCE_STATE_UNSPECIFIED", #enumValue: 0} |
	{"EVIDENCE_STATE_DECLARED", #enumValue: 1} |
	{"EVIDENCE_STATE_CONSTRUCTED", #enumValue: 2} |
	{"EVIDENCE_STATE_CHECKED", #enumValue: 3} |
	{"EVIDENCE_STATE_INFERRED", #enumValue: 4} |
	{"EVIDENCE_STATE_STALE", #enumValue: 5}

#EvidenceState_value: {
	EVIDENCE_STATE_UNSPECIFIED: 0
	EVIDENCE_STATE_DECLARED:    1
	EVIDENCE_STATE_CONSTRUCTED: 2
	EVIDENCE_STATE_CHECKED:     3
	EVIDENCE_STATE_INFERRED:    4
	EVIDENCE_STATE_STALE:       5
}
#UiOutcome: {"UI_OUTCOME_UNSPECIFIED", #enumValue: 0} |
	{"UI_OUTCOME_FAILED", #enumValue: 1} |
	{"UI_OUTCOME_MISSING", #enumValue: 2}

#UiOutcome_value: {
	UI_OUTCOME_UNSPECIFIED: 0
	UI_OUTCOME_FAILED:      1
	UI_OUTCOME_MISSING:     2
}
#EvidenceKind: {"EVIDENCE_KIND_UNSPECIFIED", #enumValue: 0} |
	{"EVIDENCE_KIND_NATIVE_READBACK", #enumValue: 1} |
	{"EVIDENCE_KIND_CALIBRATED_OBSERVATION", #enumValue: 2} |
	{"EVIDENCE_KIND_DETERMINISTIC_COMPUTATION", #enumValue: 3} |
	{"EVIDENCE_KIND_SOURCE_DECLARATION", #enumValue: 4} |
	{"EVIDENCE_KIND_MACHINE_INFERENCE", #enumValue: 5} |
	{"EVIDENCE_KIND_GENERATED_HYPOTHESIS", #enumValue: 6}

#EvidenceKind_value: {
	EVIDENCE_KIND_UNSPECIFIED:               0
	EVIDENCE_KIND_NATIVE_READBACK:           1
	EVIDENCE_KIND_CALIBRATED_OBSERVATION:    2
	EVIDENCE_KIND_DETERMINISTIC_COMPUTATION: 3
	EVIDENCE_KIND_SOURCE_DECLARATION:        4
	EVIDENCE_KIND_MACHINE_INFERENCE:         5
	EVIDENCE_KIND_GENERATED_HYPOTHESIS:      6
}
#ChannelKind: {"CHANNEL_KIND_UNSPECIFIED", #enumValue: 0} |
	{"CHANNEL_KIND_STATE", #enumValue: 1} |
	{"CHANNEL_KIND_TSDF", #enumValue: 2} |
	{"CHANNEL_KIND_WEIGHT", #enumValue: 3} |
	{"CHANNEL_KIND_RGB", #enumValue: 4} |
	{"CHANNEL_KIND_INSTANCE_LABEL", #enumValue: 5} |
	{"CHANNEL_KIND_FILL", #enumValue: 6} |
	{"CHANNEL_KIND_NORMAL", #enumValue: 7} |
	{"CHANNEL_KIND_FEATURE_REF", #enumValue: 8} |
	{"CHANNEL_KIND_SIGMA", #enumValue: 9}

#ChannelKind_value: {
	CHANNEL_KIND_UNSPECIFIED:    0
	CHANNEL_KIND_STATE:          1
	CHANNEL_KIND_TSDF:           2
	CHANNEL_KIND_WEIGHT:         3
	CHANNEL_KIND_RGB:            4
	CHANNEL_KIND_INSTANCE_LABEL: 5
	CHANNEL_KIND_FILL:           6
	CHANNEL_KIND_NORMAL:         7
	CHANNEL_KIND_FEATURE_REF:    8
	CHANNEL_KIND_SIGMA:          9
}
#CapabilityRung: {"CAPABILITY_RUNG_UNSPECIFIED", #enumValue: 0} |
	{"CAPABILITY_RUNG_DECLARED", #enumValue: 1} |
	{"CAPABILITY_RUNG_CONFIGURED", #enumValue: 2} |
	{"CAPABILITY_RUNG_FILES_PRESENT", #enumValue: 3} |
	{"CAPABILITY_RUNG_INTERPRETER_RUNS", #enumValue: 4} |
	{"CAPABILITY_RUNG_SDK_IMPORTS", #enumValue: 5} |
	{"CAPABILITY_RUNG_SMOKE_RUN", #enumValue: 6} |
	{"CAPABILITY_RUNG_OBSERVED_OPERATION", #enumValue: 7} |
	{"CAPABILITY_RUNG_QUALIFIED", #enumValue: 8} |
	{"CAPABILITY_RUNG_DEPLOYED", #enumValue: 9}

#CapabilityRung_value: {
	CAPABILITY_RUNG_UNSPECIFIED:        0
	CAPABILITY_RUNG_DECLARED:           1
	CAPABILITY_RUNG_CONFIGURED:         2
	CAPABILITY_RUNG_FILES_PRESENT:      3
	CAPABILITY_RUNG_INTERPRETER_RUNS:   4
	CAPABILITY_RUNG_SDK_IMPORTS:        5
	CAPABILITY_RUNG_SMOKE_RUN:          6
	CAPABILITY_RUNG_OBSERVED_OPERATION: 7
	CAPABILITY_RUNG_QUALIFIED:          8
	CAPABILITY_RUNG_DEPLOYED:           9
}
#LicenseTier: {"LICENSE_TIER_UNSPECIFIED", #enumValue: 0} |
	{"LICENSE_TIER_COMMERCIAL", #enumValue: 1} |
	{"LICENSE_TIER_RESEARCH_ONLY", #enumValue: 2} |
	{"LICENSE_TIER_NEEDS_LICENSE", #enumValue: 3} |
	{"LICENSE_TIER_VERIFY", #enumValue: 4}

#LicenseTier_value: {
	LICENSE_TIER_UNSPECIFIED:   0
	LICENSE_TIER_COMMERCIAL:    1
	LICENSE_TIER_RESEARCH_ONLY: 2
	LICENSE_TIER_NEEDS_LICENSE: 3
	LICENSE_TIER_VERIFY:        4
}
#JobState: {"JOB_STATE_UNSPECIFIED", #enumValue: 0} |
	{"JOB_STATE_QUEUED", #enumValue: 1} |
	{"JOB_STATE_RUNNING", #enumValue: 2} |
	{"JOB_STATE_SUCCEEDED", #enumValue: 3} |
	{"JOB_STATE_FAILED", #enumValue: 4} |
	{"JOB_STATE_CANCELLED", #enumValue: 5} |
	{"JOB_STATE_INTERRUPTED", #enumValue: 6}

#JobState_value: {
	JOB_STATE_UNSPECIFIED: 0
	JOB_STATE_QUEUED:      1
	JOB_STATE_RUNNING:     2
	JOB_STATE_SUCCEEDED:   3
	JOB_STATE_FAILED:      4
	JOB_STATE_CANCELLED:   5
	JOB_STATE_INTERRUPTED: 6
}

#Vec3: {
	x?: float64 @protobuf(1,double)
	y?: float64 @protobuf(2,double)
	z?: float64 @protobuf(3,double)
}

#Int3: {
	x?: int32 @protobuf(1,sint32)
	y?: int32 @protobuf(2,sint32)
	z?: int32 @protobuf(3,sint32)
}

#Basis: {
	x?: #Vec3 @protobuf(1,Vec3)
	y?: #Vec3 @protobuf(2,Vec3)
	z?: #Vec3 @protobuf(3,Vec3)
}

#Identity: {
	id?:             string @protobuf(1,string)
	sourceRevision?: string @protobuf(2,string,name=source_revision)
	frameId?:        string @protobuf(3,string,name=frame_id)
	objectId?:       string @protobuf(4,string,name=object_id)
	regionId?:       string @protobuf(5,string,name=region_id)
}

#Frame: {
	identity?: #Identity @protobuf(1,Identity)
	units?:    #Units    @protobuf(2,Units)
	origin?:   #Vec3     @protobuf(3,Vec3)
	basis?:    #Basis    @protobuf(4,Basis)
}

#EvidenceReference: {
	handleId?:       string        @protobuf(1,string,name=handle_id)
	runId?:          string        @protobuf(2,string,name=run_id)
	sourceRevision?: string        @protobuf(3,string,name=source_revision)
	objectId?:       string        @protobuf(4,string,name=object_id)
	regionId?:       string        @protobuf(5,string,name=region_id)
	kind?:           #EvidenceKind @protobuf(6,EvidenceKind)
}

// This is a transport reference, never an admission token or a cited:true bit.
// Existing createEvidenceAdmission retains sole controller authority.
#Evidence: {
	kind?:           #EvidenceKind  @protobuf(1,EvidenceKind)
	state?:          #EvidenceState @protobuf(2,EvidenceState)
	provenance?:     #Provenance    @protobuf(3,Provenance)
	runId?:          string         @protobuf(4,string,name=run_id)
	sourceRevision?: string         @protobuf(5,string,name=source_revision)
	objectId?:       string         @protobuf(6,string,name=object_id)
	regionId?:       string         @protobuf(7,string,name=region_id)
	references?: [...#EvidenceReference] @protobuf(8,EvidenceReference)
	rawModelResponse?: bytes @protobuf(9,bytes,name=raw_model_response)
	refusal?:          bytes @protobuf(10,bytes)
}

#UncertaintyBudget: {
	fiducialScaleMm?:       float64 @protobuf(1,double,name=fiducial_scale_mm)
	calibrationResidualMm?: float64 @protobuf(2,double,name=calibration_residual_mm)
	edgeLocalizationMm?:    float64 @protobuf(3,double,name=edge_localization_mm)
	sensorFloorMm?:         float64 @protobuf(4,double,name=sensor_floor_mm)
}

#Dimension: {
	valueMm?:              float64            @protobuf(1,double,name=value_mm)
	plusMinusMm?:          float64            @protobuf(2,double,name=plus_minus_mm)
	budget?:               #UncertaintyBudget @protobuf(3,UncertaintyBudget)
	evidence?:             #Evidence          @protobuf(4,Evidence)
	measured?:             bool               @protobuf(5,bool)
	caliperMm?:            float64            @protobuf(6,double,name=caliper_mm)
	frozenThresholdMm?:    float64            @protobuf(7,double,name=frozen_threshold_mm)
	instrument?:           string             @protobuf(8,string)
	benchmarkApprovalRef?: string             @protobuf(9,string,name=benchmark_approval_ref)
}

// Raw floating producer arrays are distinct from encoded ledger channels.
// Quantization only in Rust: finite input, declared scale/clamp, half-even.
#Quantization: {
	scale?:    float64 @protobuf(1,double)
	clampMin?: float64 @protobuf(2,double,name=clamp_min)
	clampMax?: float64 @protobuf(3,double,name=clamp_max)
	rounding?: string  @protobuf(4,string)
	owner?:    string  @protobuf(5,string)
}

#ChannelDeclaration: {
	kind?:         #ChannelKind  @protobuf(1,ChannelKind)
	storage?:      string        @protobuf(2,string)
	components?:   uint32        @protobuf(3,uint32)
	unit?:         string        @protobuf(4,string)
	quantization?: #Quantization @protobuf(5,Quantization)

	// Sigma declarations require statistic = "1sigma" and unit = "um".
	statistic?: string @protobuf(6,string)
}

#RawChannel: {
	kind?: #ChannelKind @protobuf(1,ChannelKind)
	values?: [...float64] @protobuf(2,double)
}

#RawVoxelInput: {
	schema?:         string @protobuf(1,string)
	sourceRevision?: string @protobuf(2,string,name=source_revision)
	channels?: [...#RawChannel] @protobuf(3,RawChannel)
}

#VoxelHeader: {
	schema?:            string  @protobuf(1,string)
	frameId?:           string  @protobuf(2,string,name=frame_id)
	units?:             #Units  @protobuf(3,Units)
	voxelSize?:         float64 @protobuf(4,double,name=voxel_size)
	origin?:            #Vec3   @protobuf(5,Vec3)
	basis?:             #Basis  @protobuf(6,Basis)
	channelSchemaHash?: bytes   @protobuf(7,bytes,name=channel_schema_hash)
	sourceRevision?:    string  @protobuf(8,string,name=source_revision)
	channels?: [...#ChannelDeclaration] @protobuf(9,ChannelDeclaration)
	topologyLog2?: [...uint32] @protobuf(10,uint32,name=topology_log2)
}

#U8Channel: {
	values?: [...uint32] @protobuf(1,uint32)
}

#I16Channel: {
	values?: [...int32] @protobuf(1,sint32)
}

#U16Channel: {
	values?: [...uint32] @protobuf(1,uint32)
}

#U32Channel: {
	values?: [...uint32] @protobuf(1,uint32)
}

#RGB8: {
	r?: uint32 @protobuf(1,uint32)
	g?: uint32 @protobuf(2,uint32)
	b?: uint32 @protobuf(3,uint32)
}

#RGB8Channel: {
	values?: [...#RGB8] @protobuf(1,RGB8)
}

#Normal8: {
	x?: int32 @protobuf(1,sint32)
	y?: int32 @protobuf(2,sint32)
	z?: int32 @protobuf(3,sint32)
}

#Normal8Channel: {
	values?: [...#Normal8] @protobuf(1,Normal8)
}

#LeafMetadata: {
	provenance?:       #Provenance    @protobuf(1,Provenance)
	evidenceState?:    #EvidenceState @protobuf(2,EvidenceState,name=evidence_state)
	observationCount?: uint32         @protobuf(3,uint32,name=observation_count)
	sourceSetHash?:    bytes          @protobuf(4,bytes,name=source_set_hash)
}

// Optional message presence distinguishes unrecorded sigma from 512 zero codes.
// sigma is u16, 1-sigma micrometres. Ledger resolution is never accuracy.
#VoxelLeaf: {
	origin?:   #Int3         @protobuf(1,Int3)
	metadata?: #LeafMetadata @protobuf(2,LeafMetadata)
	channelOrder?: [...#ChannelKind] @protobuf(3,ChannelKind,name=channel_order)
	state?:         #U8Channel      @protobuf(4,U8Channel)
	tsdf?:          #I16Channel     @protobuf(5,I16Channel)
	weight?:        #U16Channel     @protobuf(6,U16Channel)
	rgb?:           #RGB8Channel    @protobuf(7,RGB8Channel)
	instanceLabel?: #U32Channel     @protobuf(8,U32Channel,name=instance_label)
	fill?:          #U16Channel     @protobuf(9,U16Channel)
	normal?:        #Normal8Channel @protobuf(10,Normal8Channel)
	featureRef?:    #U32Channel     @protobuf(11,U32Channel,name=feature_ref)
	sigma?:         #U16Channel     @protobuf(12,U16Channel)
}

#VoxelRegion: {
	identity?:  #Identity   @protobuf(1,Identity)
	allocated?: bool        @protobuf(2,bool)
	state?:     #VoxelState @protobuf(3,VoxelState)
	leaf?:      #VoxelLeaf  @protobuf(4,VoxelLeaf)
}

#SourceVersion: {
	producer?: string @protobuf(1,string)
	version?:  string @protobuf(2,string)
	revision?: string @protobuf(3,string)
}

#License: {
	tier?: #LicenseTier @protobuf(1,LicenseTier)
	sources?: [...string] @protobuf(2,string)
}

#Capability: {
	verb?:       string          @protobuf(1,string)
	rung?:       #CapabilityRung @protobuf(2,CapabilityRung)
	observedAt?: string          @protobuf(3,string,name=observed_at)
	supportingReferences?: [...#EvidenceReference] @protobuf(4,EvidenceReference,name=supporting_references)
	license?:        #License @protobuf(5,License)
	publicEligible?: bool     @protobuf(6,bool,name=public_eligible)
	nextAction?:     string   @protobuf(7,string,name=next_action)
}

#Observation: {
	identity?: #Identity @protobuf(1,Identity)
	evidence?: #Evidence @protobuf(2,Evidence)
	dimensions?: [...#Dimension] @protobuf(3,Dimension)
}

#Relation: {
	identity?:    #Identity @protobuf(1,Identity)
	subjectId?:   string    @protobuf(2,string,name=subject_id)
	predicate?:   string    @protobuf(3,string)
	targetId?:    string    @protobuf(4,string,name=target_id)
	established?: bool      @protobuf(5,bool)
	method?:      string    @protobuf(6,string)
	toleranceMm?: float64   @protobuf(7,double,name=tolerance_mm)
	voxelReferences?: [...#EvidenceReference] @protobuf(8,EvidenceReference,name=voxel_references)
	evidence?: #Evidence @protobuf(9,Evidence)
}

#Materialize: {
	identity?:          #Identity @protobuf(1,Identity)
	planHash?:          string    @protobuf(2,string,name=plan_hash)
	approvalReference?: string    @protobuf(3,string,name=approval_reference)
	jobId?:             string    @protobuf(4,string,name=job_id)
	approved?:          bool      @protobuf(5,bool)
}

#Proof: {
	identity?: #Identity @protobuf(1,Identity)
	root?:     bytes     @protobuf(2,bytes)
	leafHash?: bytes     @protobuf(3,bytes,name=leaf_hash)
	siblings?: [...bytes] @protobuf(4,bytes)
	childMask?:     bytes @protobuf(5,bytes,name=child_mask)
	unknownRegion?: bool  @protobuf(6,bool,name=unknown_region)
}

#HarnessPresence: {
	harness?:        string @protobuf(1,string)
	model?:          string @protobuf(2,string)
	nodeId?:         string @protobuf(3,string,name=node_id)
	room?:           string @protobuf(4,string)
	jobId?:          string @protobuf(5,string,name=job_id)
	sourceRevision?: string @protobuf(6,string,name=source_revision)
	targetRegionId?: string @protobuf(7,string,name=target_region_id)
}

#Space: {
	identity?: #Identity @protobuf(1,Identity)
	evidence?: #Evidence @protobuf(2,Evidence)
	references?: [...string] @protobuf(3,string)
}

#Datum: {
	identity?: #Identity @protobuf(1,Identity)
	evidence?: #Evidence @protobuf(2,Evidence)
	references?: [...string] @protobuf(3,string)
}

#Region: {
	identity?: #Identity @protobuf(1,Identity)
	evidence?: #Evidence @protobuf(2,Evidence)
	references?: [...string] @protobuf(3,string)
}

#Object: {
	identity?: #Identity @protobuf(1,Identity)
	evidence?: #Evidence @protobuf(2,Evidence)
	references?: [...string] @protobuf(3,string)
}

#Part: {
	identity?: #Identity @protobuf(1,Identity)
	evidence?: #Evidence @protobuf(2,Evidence)
	references?: [...string] @protobuf(3,string)
}

#Feature: {
	identity?: #Identity @protobuf(1,Identity)
	evidence?: #Evidence @protobuf(2,Evidence)
	references?: [...string] @protobuf(3,string)
}

#Profile: {
	identity?: #Identity @protobuf(1,Identity)
	evidence?: #Evidence @protobuf(2,Evidence)
	references?: [...string] @protobuf(3,string)
}

#Constraint: {
	identity?: #Identity @protobuf(1,Identity)
	evidence?: #Evidence @protobuf(2,Evidence)
	references?: [...string] @protobuf(3,string)
}

#Judgment: {
	identity?: #Identity @protobuf(1,Identity)
	evidence?: #Evidence @protobuf(2,Evidence)
	references?: [...string] @protobuf(3,string)
}

#SceneIR: {
	schema?:         string @protobuf(1,string)
	sourceRevision?: string @protobuf(2,string,name=source_revision)
	spaces?: [...#Space] @protobuf(3,Space)
	frames?: [...#Frame] @protobuf(4,Frame)
	data?: [...#Datum] @protobuf(5,Datum)
	regions?: [...#Region] @protobuf(6,Region)
	objects?: [...#Object] @protobuf(7,Object)
	parts?: [...#Part] @protobuf(8,Part)
	features?: [...#Feature] @protobuf(9,Feature)
	profiles?: [...#Profile] @protobuf(10,Profile)
	constraints?: [...#Constraint] @protobuf(11,Constraint)
	relations?: [...#Relation] @protobuf(12,Relation)
	observations?: [...#Observation] @protobuf(13,Observation)
	judgments?: [...#Judgment] @protobuf(14,Judgment)
	materializations?: [...#Materialize] @protobuf(15,Materialize)
	proofs?: [...#Proof] @protobuf(16,Proof)
	presence?: [...#HarnessPresence] @protobuf(17,HarnessPresence)
}

#Failure: {
	code?:    string @protobuf(1,string)
	message?: string @protobuf(2,string)
	details?: bytes  @protobuf(3,bytes)
}

#Recovery: {
	verifiedComplete?:  bool   @protobuf(1,bool,name=verified_complete)
	readbackReference?: string @protobuf(2,string,name=readback_reference)
	replaySafe?:        bool   @protobuf(3,bool,name=replay_safe)
	priorJobId?:        string @protobuf(4,string,name=prior_job_id)
}

#Job: {
	schema?:           string    @protobuf(1,string)
	jobId?:            string    @protobuf(2,string,name=job_id)
	operationId?:      string    @protobuf(3,string,name=operation_id)
	sourceRevision?:   string    @protobuf(4,string,name=source_revision)
	documentRevision?: string    @protobuf(5,string,name=document_revision)
	requestId?:        string    @protobuf(6,string,name=request_id)
	state?:            #JobState @protobuf(7,JobState)
	progress?:         float64   @protobuf(8,double)
	resultReferences?: [...string] @protobuf(9,string,name=result_references)
	receiptReferences?: [...string] @protobuf(10,string,name=receipt_references)
	createdAt?:          string    @protobuf(11,string,name=created_at)
	updatedAt?:          string    @protobuf(12,string,name=updated_at)
	failure?:            #Failure  @protobuf(13,Failure)
	cancellationReason?: string    @protobuf(14,string,name=cancellation_reason)
	recovery?:           #Recovery @protobuf(15,Recovery)
}

#SubmitRequest: {
	requestId?:        string @protobuf(1,string,name=request_id)
	operationId?:      string @protobuf(2,string,name=operation_id)
	sourceRevision?:   string @protobuf(3,string,name=source_revision)
	documentRevision?: string @protobuf(4,string,name=document_revision)
	capability?:       string @protobuf(5,string)
	payload?:          bytes  @protobuf(6,bytes)
}

#SubmitResponse: {
	job?: #Job @protobuf(1,Job)
}

#StatusRequest: {
	jobId?:          string @protobuf(1,string,name=job_id)
	sourceRevision?: string @protobuf(2,string,name=source_revision)
}

#StatusResponse: {
	job?: #Job @protobuf(1,Job)
}

#CancelRequest: {
	jobId?:          string @protobuf(1,string,name=job_id)
	sourceRevision?: string @protobuf(2,string,name=source_revision)
	reason?:         string @protobuf(3,string)
}

#CancelResponse: {
	job?: #Job @protobuf(1,Job)
}

#RecoverRequest: {
	jobId?:             string @protobuf(1,string,name=job_id)
	sourceRevision?:    string @protobuf(2,string,name=source_revision)
	readbackReference?: string @protobuf(3,string,name=readback_reference)
}

#RecoverResponse: {
	job?: #Job @protobuf(1,Job)
}

#ProgressRequest: {
	jobId?:          string @protobuf(1,string,name=job_id)
	sourceRevision?: string @protobuf(2,string,name=source_revision)
	afterSequence?:  uint64 @protobuf(3,uint64,name=after_sequence)
}

#ProgressResponse: {
	job?:      #Job   @protobuf(1,Job)
	sequence?: uint64 @protobuf(2,uint64)
}

// canonical_json is the unchanged existing recursive canonicalBody bytes.
// Proto encoding is transport only and never replaces signed JSON authority.
#SpatialReceipt: {
	canonicalJson?:    bytes  @protobuf(1,bytes,name=canonical_json)
	receiptId?:        string @protobuf(2,string,name=receipt_id)
	hash?:             string @protobuf(3,string)
	prevHash?:         string @protobuf(4,string,name=prev_hash)
	signature?:        bytes  @protobuf(5,bytes)
	signer?:           string @protobuf(6,string)
	harness?:          string @protobuf(7,string)
	model?:            string @protobuf(8,string)
	nodeId?:           string @protobuf(9,string,name=node_id)
	room?:             string @protobuf(10,string)
	jobId?:            string @protobuf(11,string,name=job_id)
	sourceRevision?:   string @protobuf(12,string,name=source_revision)
	root?:             bytes  @protobuf(13,bytes)
	headerHash?:       bytes  @protobuf(14,bytes,name=header_hash)
	header?:           bytes  @protobuf(15,bytes)
	leafCount?:        uint32 @protobuf(16,uint32,name=leaf_count)
	changedLeafCount?: uint32 @protobuf(17,uint32,name=changed_leaf_count)
	producerVersions?: [...#SourceVersion] @protobuf(18,SourceVersion,name=producer_versions)
	evidence?: #Evidence @protobuf(19,Evidence)
}

// A transport fixture envelope; it grants no native/physical capabilities.
#ContractFixture: {
	frame?:  #Frame       @protobuf(1,Frame)
	header?: #VoxelHeader @protobuf(2,VoxelHeader)
	leaf?:   #VoxelLeaf   @protobuf(3,VoxelLeaf)
	region?: #VoxelRegion @protobuf(4,VoxelRegion)
	scene?:  #SceneIR     @protobuf(5,SceneIR)
	jobs?: [...#Job] @protobuf(6,Job)
	progress?: [...#ProgressResponse] @protobuf(7,ProgressResponse)
	receipt?:    #SpatialReceipt @protobuf(8,SpatialReceipt)
	capability?: #Capability     @protobuf(9,Capability)
	dimension?:  #Dimension      @protobuf(10,Dimension)
	relation?:   #Relation       @protobuf(11,Relation)
}
